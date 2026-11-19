import {
  daysUntil,
  emailSchema,
  SSO_SECRET_WARN_DAYS,
  type entraSettingsRequestSchema,
  type EntraSettings,
  type EntraState,
  type EntraTestResult,
  type Role,
  type User,
} from '@open-itsm/shared';
import { eq } from 'drizzle-orm';
import * as client from 'openid-client';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { decryptSecret, encryptSecret, SecretDecryptError } from '../crypto.js';
import type { Db } from '../db/client.js';
import { requesters, settings, users } from '../db/schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const ENTRA_CONFIG_KEY = 'entra';
const STATE_KEY = 'entra.state';
const SECRET_CONTEXT = 'entra.client_secret';
const OIDC_COOKIE_CONTEXT = 'entra.oidc_state';

/** Short-lived HttpOnly cookie binding the OIDC callback to the browser that started sign-in. */
export const OIDC_COOKIE = '__Host-itsm_oidc';
export const OIDC_TTL_SECONDS = 10 * 60;
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;
const GRAPH_TIMEOUT_MS = 15_000;

type EntraInput = z.output<typeof entraSettingsRequestSchema>;

type StoredConfig = {
  tenantId: string;
  clientId: string;
  technicianGroupId: string;
  secretExpiresOn: string | null;
  enabled: boolean;
};

type StoredState = {
  lastSuccessAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
};

type OidcCookiePayload = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string;
  exp: number;
};

export type EntraOptions = {
  secretKey: Buffer;
  loginUrl: string;
  graphUrl: string;
  siteUrl: string | null;
  /** Tests pass a stand-in OIDC + Graph fetch. */
  fetch?: typeof fetch | undefined;
};

export class EntraNoSecretError extends Error {}

/** An SSO error safe to show to the user or administrator. */
export class EntraAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Whether this looks like a configuration/provider failure to record on the SSO page. */
    readonly recordOnStatus = false,
  ) {
    super(message);
    this.name = 'EntraAuthError';
  }
}

function asCustomFetch(fetchImpl: typeof fetch): client.CustomFetch {
  return (url, options) => fetchImpl(url, options as RequestInit);
}

/** Ensures a redirect target stays on this site. */
export function safeReturnTo(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

function friendlyOidcError(err: unknown): string {
  if (err instanceof EntraAuthError) return err.message;
  if (err instanceof SecretDecryptError) {
    return 'The stored Entra ID client secret could not be decrypted. Check APP_SECRET_KEY or save the secret again.';
  }
  const msg = err instanceof Error ? err.message : String(err);
  const aad = /AADSTS(\d+)/.exec(msg)?.[1];
  switch (aad) {
    case '90002':
    case '900023':
      return 'Microsoft did not recognize the directory (tenant) ID. Check the SSO settings.';
    case '700016':
      return 'No app with that client ID is registered in this directory. Check the SSO settings.';
    case '7000215':
      return 'Microsoft refused the client secret. Enter the secret Value (not its ID) in SSO settings.';
    case '7000222':
      return 'The Entra ID client secret has expired. Create a new secret and save it in SSO settings.';
    case '50011':
      return 'The redirect URI does not match the Entra ID app registration. Copy the redirect URI from the SSO settings page into Entra ID.';
    default:
      return 'Microsoft sign-in could not be completed. Try again, or sign in with your local account.';
  }
}

/**
 * Optional Microsoft Entra ID sign-in using OpenID Connect authorization code flow with PKCE.
 * Members of the configured technician group sign in as technicians; when the end-user portal
 * is enabled (M10), other tenant users sign in as end users. Local accounts always keep working.
 */
export class EntraService {
  private discoveryCache: {
    key: string;
    config: client.Configuration;
    expiresAt: number;
  } | null = null;

  /** Set in M10 so non-group Entra users can sign in as end users when the portal is on. */
  allowEndUsers: () => Promise<boolean> = async () => false;

  get siteUrl(): string | null {
    return this.options.siteUrl;
  }

  constructor(
    readonly db: Db,
    private readonly options: EntraOptions,
    private readonly log: Logger,
  ) {}

  private async load(): Promise<{ config: StoredConfig; secret: string | null } | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, ENTRA_CONFIG_KEY));
    if (!row) return null;
    return { config: row.value as StoredConfig, secret: row.secret };
  }

  private async loadState(executor: Pick<Db, 'select'> = this.db): Promise<StoredState> {
    const [row] = await executor.select().from(settings).where(eq(settings.key, STATE_KEY));
    return (row?.value ?? {}) as StoredState;
  }

  private async saveState(patch: Partial<StoredState>): Promise<void> {
    const now = new Date();
    const current = await this.loadState();
    const next: StoredState = { ...current, ...patch };
    await this.db
      .insert(settings)
      .values({ key: STATE_KEY, value: next, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } });
  }

  private decrypt(stored: string): string {
    return decryptSecret(this.options.secretKey, stored, SECRET_CONTEXT);
  }

  private issuerUrl(tenantId: string): URL {
    return new URL(`${this.options.loginUrl}/${encodeURIComponent(tenantId.toLowerCase())}/v2.0`);
  }

  private async discover(
    tenantId: string,
    clientId: string,
    secret: string,
    cacheKey?: string,
  ): Promise<client.Configuration> {
    if (
      cacheKey &&
      this.discoveryCache &&
      this.discoveryCache.key === cacheKey &&
      this.discoveryCache.expiresAt > Date.now()
    ) {
      return this.discoveryCache.config;
    }
    const fetchImpl = this.options.fetch ?? fetch;
    const oidcConfig = await client.discovery(
      this.issuerUrl(tenantId),
      clientId,
      undefined,
      client.ClientSecretPost(secret),
      { [client.customFetch]: asCustomFetch(fetchImpl) },
    );
    if (cacheKey) {
      this.discoveryCache = {
        key: cacheKey,
        config: oidcConfig,
        expiresAt: Date.now() + DISCOVERY_CACHE_MS,
      };
    }
    return oidcConfig;
  }

  async isEnabled(): Promise<boolean> {
    const loaded = await this.load();
    return Boolean(loaded?.secret && loaded.config.enabled);
  }

  async settings(now = new Date()): Promise<EntraSettings> {
    const loaded = await this.load();
    const redirectUri = this.options.siteUrl
      ? `${this.options.siteUrl}/api/auth/entra/callback`
      : null;
    if (!loaded) {
      return {
        configured: false,
        tenantId: '',
        clientId: '',
        technicianGroupId: '',
        secretExpiresOn: null,
        secretSet: false,
        enabled: false,
        state: 'not_configured',
        redirectUri,
        lastError: null,
        lastErrorAt: null,
      };
    }
    const { config } = loaded;
    const stateRow = await this.loadState();
    const failing =
      stateRow.lastError != null &&
      (stateRow.lastSuccessAt == null ||
        (stateRow.lastErrorAt != null && stateRow.lastErrorAt > stateRow.lastSuccessAt));
    const days = config.secretExpiresOn ? daysUntil(config.secretExpiresOn, now) : null;
    let state: EntraState;
    if (!loaded.secret) state = 'not_configured';
    else if (!config.enabled) state = 'off';
    else if (days !== null && days < 0) state = 'secret_expired';
    else if (failing) state = 'failing';
    else if (days !== null && days <= SSO_SECRET_WARN_DAYS) state = 'secret_expiring';
    else state = 'connected';
    return {
      configured: loaded.secret !== null,
      tenantId: config.tenantId,
      clientId: config.clientId,
      technicianGroupId: config.technicianGroupId,
      secretExpiresOn: config.secretExpiresOn,
      secretSet: loaded.secret !== null,
      enabled: config.enabled,
      state,
      redirectUri,
      lastError: failing ? (stateRow.lastError ?? null) : null,
      lastErrorAt: failing ? (stateRow.lastErrorAt ?? null) : null,
    };
  }

  /** Saves Entra ID SSO settings. A blank secret keeps the stored one. */
  async save(input: EntraInput, actorUserId: string): Promise<string[]> {
    return this.db.transaction(async (tx: Tx) => {
      const [row] = await tx
        .select()
        .from(settings)
        .where(eq(settings.key, ENTRA_CONFIG_KEY))
        .for('update');
      const before = row?.value as StoredConfig | undefined;
      if (!input.clientSecret && !row?.secret) throw new EntraNoSecretError();
      const now = new Date();
      const config: StoredConfig = {
        tenantId: input.tenantId.toLowerCase(),
        clientId: input.clientId.toLowerCase(),
        technicianGroupId: input.technicianGroupId.toLowerCase(),
        secretExpiresOn: input.secretExpiresOn ?? null,
        enabled: input.enabled,
      };
      const secret = input.clientSecret
        ? encryptSecret(this.options.secretKey, input.clientSecret, SECRET_CONTEXT)
        : (row?.secret ?? null);
      await tx
        .insert(settings)
        .values({
          key: ENTRA_CONFIG_KEY,
          value: config,
          secret,
          updatedAt: now,
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: config, secret, updatedAt: now, updatedBy: actorUserId },
        });
      const changed = (
        ['tenantId', 'clientId', 'technicianGroupId', 'secretExpiresOn', 'enabled'] as const
      )
        .filter((k) => before?.[k] !== config[k])
        .map(String);
      if (input.clientSecret) changed.push('clientSecret');
      if (changed.length > 0) {
        await tx
          .insert(settings)
          .values({ key: STATE_KEY, value: { lastError: null, lastErrorAt: null }, updatedAt: now })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: { lastError: null, lastErrorAt: null }, updatedAt: now },
          });
      }
      this.discoveryCache = null;
      return changed;
    });
  }

  /** Switches Entra ID sign-in off without removing settings (used by recovery CLI). */
  async disable(): Promise<'disabled' | 'already_off' | 'not_configured'> {
    return this.db.transaction(async (tx: Tx) => {
      const [row] = await tx
        .select()
        .from(settings)
        .where(eq(settings.key, ENTRA_CONFIG_KEY))
        .for('update');
      if (!row) return 'not_configured';
      const config = row.value as StoredConfig;
      if (!config.enabled) return 'already_off';
      await tx
        .update(settings)
        .set({ value: { ...config, enabled: false }, updatedAt: new Date() })
        .where(eq(settings.key, ENTRA_CONFIG_KEY));
      this.discoveryCache = null;
      return 'disabled';
    });
  }

  /** Removes the Entra ID configuration and forgets the client secret. */
  async disconnect(): Promise<boolean> {
    const removed = await this.db
      .delete(settings)
      .where(eq(settings.key, ENTRA_CONFIG_KEY))
      .returning({ key: settings.key });
    await this.db.delete(settings).where(eq(settings.key, STATE_KEY));
    this.discoveryCache = null;
    return removed.length > 0;
  }

  /** Tests OpenID Connect discovery for these settings without saving them. */
  async test(input: EntraInput): Promise<EntraTestResult> {
    let secret = input.clientSecret;
    if (!secret) {
      const loaded = await this.load();
      if (!loaded?.secret) throw new EntraNoSecretError();
      secret = this.decrypt(loaded.secret);
    }
    try {
      const oidcConfig = await this.discover(input.tenantId, input.clientId, secret);
      const meta = oidcConfig.serverMetadata();
      if (!meta.authorization_endpoint || !meta.token_endpoint) {
        return {
          ok: false,
          message:
            'The OpenID Connect metadata for this tenant is missing required sign-in endpoints.',
        };
      }
      return {
        ok: true,
        message: `Connected to Microsoft Entra ID OpenID configuration for tenant ${input.tenantId}.`,
      };
    } catch (err) {
      this.log.warn({ err }, 'Entra ID discovery test failed');
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Could not load OpenID Connect configuration for tenant ${input.tenantId} (${detail}). Check the tenant ID and network access.`,
      };
    }
  }

  /**
   * Starts the OIDC authorization code + PKCE flow. Returns the Microsoft authorization URL
   * and the encrypted cookie value that binds the callback to this browser.
   */
  async startAuth(
    redirectUri: string,
    returnTo: string | undefined,
  ): Promise<{ authorizationUrl: string; cookieValue: string }> {
    const loaded = await this.load();
    if (!loaded?.secret || !loaded.config.enabled) {
      throw new EntraAuthError(
        'sso_disabled',
        'Microsoft sign-in is switched off. Sign in with your local account.',
      );
    }
    const { config } = loaded;
    let oidcConfig: client.Configuration;
    try {
      const secret = this.decrypt(loaded.secret);
      const cacheKey = `${config.tenantId}|${config.clientId}|${loaded.secret}`;
      oidcConfig = await this.discover(config.tenantId, config.clientId, secret, cacheKey);
    } catch (err) {
      this.log.warn({ err }, 'Entra ID sign-in start failed');
      const message = friendlyOidcError(err);
      await this.saveState({ lastError: message, lastErrorAt: new Date().toISOString() });
      throw new EntraAuthError('sso_misconfigured', message, true);
    }

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: redirectUri,
      scope: 'openid profile email User.Read GroupMember.Read.All',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    const payload: OidcCookiePayload = {
      state,
      nonce,
      codeVerifier,
      redirectUri,
      returnTo: safeReturnTo(returnTo),
      exp: Date.now() + OIDC_TTL_SECONDS * 1000,
    };
    const cookieValue = encryptSecret(
      this.options.secretKey,
      JSON.stringify(payload),
      OIDC_COOKIE_CONTEXT,
    );
    return { authorizationUrl: authorizationUrl.href, cookieValue };
  }

  /**
   * Completes the OIDC callback, verifies PKCE/state/nonce and group membership (falling back
   * to Graph when the token omits groups due to overage), and provisions or updates the user.
   */
  async completeAuth(
    callbackUrl: URL,
    cookieValue: string | undefined,
  ): Promise<{ user: User; returnTo: string }> {
    const loaded = await this.load();
    if (!loaded?.secret || !loaded.config.enabled) {
      throw new EntraAuthError(
        'sso_disabled',
        'Microsoft sign-in is switched off. Sign in with your local account.',
      );
    }

    // Microsoft sent an error parameter directly back to the callback (e.g. access_denied).
    const providerError = callbackUrl.searchParams.get('error');
    if (providerError) {
      const desc = callbackUrl.searchParams.get('error_description') ?? '';
      if (providerError === 'access_denied') {
        throw new EntraAuthError(
          'sso_cancelled',
          'Microsoft sign-in was cancelled. Try again, or sign in with your local account.',
        );
      }
      const message = friendlyOidcError(new Error(`${providerError}: ${desc}`));
      await this.saveState({ lastError: message, lastErrorAt: new Date().toISOString() });
      throw new EntraAuthError('sso_provider_error', message, true);
    }

    if (!cookieValue) {
      throw new EntraAuthError(
        'sso_state_missing',
        'Your sign-in session expired before Microsoft returned. Start sign-in again.',
      );
    }

    let payload: OidcCookiePayload;
    try {
      payload = JSON.parse(
        decryptSecret(this.options.secretKey, cookieValue, OIDC_COOKIE_CONTEXT),
      ) as OidcCookiePayload;
    } catch {
      throw new EntraAuthError(
        'sso_state_invalid',
        'Your sign-in request could not be verified. Start sign-in again.',
      );
    }
    if (!payload.exp || payload.exp < Date.now()) {
      throw new EntraAuthError(
        'sso_state_expired',
        'Your sign-in took too long and expired. Start sign-in again.',
      );
    }

    const { config } = loaded;
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      const secret = this.decrypt(loaded.secret);
      const cacheKey = `${config.tenantId}|${config.clientId}|${loaded.secret}`;
      const oidcConfig = await this.discover(config.tenantId, config.clientId, secret, cacheKey);
      tokens = await client.authorizationCodeGrant(oidcConfig, callbackUrl, {
        pkceCodeVerifier: payload.codeVerifier,
        expectedState: payload.state,
        expectedNonce: payload.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      this.log.warn({ err }, 'Entra ID token exchange failed');
      const message = friendlyOidcError(err);
      await this.saveState({ lastError: message, lastErrorAt: new Date().toISOString() });
      throw new EntraAuthError('sso_exchange_failed', message, true);
    }

    const claims = tokens.claims();
    if (!claims) {
      throw new EntraAuthError(
        'sso_no_claims',
        'Microsoft did not return an identity token. Check the app registration and try again.',
        true,
      );
    }

    const subject =
      typeof claims.oid === 'string' && claims.oid.trim() !== ''
        ? claims.oid.trim()
        : String(claims.sub);
    const rawEmail = [claims.email, claims.preferred_username, claims.upn].find(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    const parsedEmail = emailSchema.safeParse(rawEmail ?? '');
    if (!parsedEmail.success) {
      throw new EntraAuthError(
        'sso_no_email',
        'Your Microsoft account did not provide a valid email address. Check the account in Entra ID.',
      );
    }
    const email = parsedEmail.data;
    const name =
      typeof claims.name === 'string' && claims.name.trim() !== '' ? claims.name.trim() : email;

    const isTechnician = await this.isInTechnicianGroup(
      claims,
      tokens.access_token,
      config.technicianGroupId,
    );
    const portalEnabled = await this.allowEndUsers();

    const user = await this.resolveUser({ subject, email, name, isTechnician, portalEnabled });
    await this.saveState({
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      lastErrorAt: null,
    });
    return {
      user,
      returnTo: user.role === 'end_user' ? '/portal' : payload.returnTo,
    };
  }

  /**
   * Checks whether the user belongs to the configured technician group. Uses the ID token's
   * `groups` claim when present, and falls back to Microsoft Graph `POST /me/checkMemberGroups`
   * when Entra ID omits groups (group overage or unconfigured optional claim).
   */
  private async isInTechnicianGroup(
    claims: Record<string, unknown>,
    accessToken: string | undefined,
    technicianGroupId: string,
  ): Promise<boolean> {
    const target = technicianGroupId.toLowerCase();
    if (Array.isArray(claims.groups)) {
      return claims.groups.some((g) => typeof g === 'string' && g.toLowerCase() === target);
    }

    // Group overage (`_claim_names.groups` or `hasgroups: true`) or `groups` claim omitted.
    if (!accessToken) {
      throw new EntraAuthError(
        'sso_groups_unavailable',
        'Could not check your Entra ID group membership because no Graph access token was returned. Grant delegated GroupMember.Read.All permission on the app registration.',
        true,
      );
    }

    const fetchImpl = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${this.options.graphUrl}/me/checkMemberGroups`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ groupIds: [technicianGroupId] }),
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (err) {
      this.log.warn({ err }, 'Graph checkMemberGroups failed');
      const message =
        'Could not reach Microsoft Graph to check group membership. Try again, or sign in with your local account.';
      await this.saveState({ lastError: message, lastErrorAt: new Date().toISOString() });
      throw new EntraAuthError('sso_graph_unreachable', message, true);
    }

    if (!res.ok) {
      const message =
        res.status === 401 || res.status === 403
          ? 'Microsoft Graph refused the group membership check. Grant delegated GroupMember.Read.All permission with admin consent on the Entra ID app registration.'
          : `Microsoft Graph returned an error (${res.status}) while checking group membership.`;
      await this.saveState({ lastError: message, lastErrorAt: new Date().toISOString() });
      throw new EntraAuthError('sso_graph_denied', message, true);
    }

    const body = (await res.json().catch(() => ({}))) as { value?: unknown };
    if (!Array.isArray(body.value)) return false;
    return body.value.some((g) => typeof g === 'string' && g.toLowerCase() === target);
  }

  private async resolveUser(input: {
    subject: string;
    email: string;
    name: string;
    isTechnician: boolean;
    portalEnabled: boolean;
  }): Promise<User> {
    const { subject, email, name, isTechnician, portalEnabled } = input;
    return this.db.transaction(async (tx: Tx) => {
      const [bySubject] = await tx.select().from(users).where(eq(users.entraSubject, subject));
      const [byEmail] = bySubject
        ? [bySubject]
        : await tx.select().from(users).where(eq(users.email, email));
      const existing = bySubject ?? byEmail;

      if (existing?.disabledAt) {
        throw new EntraAuthError(
          'account_disabled',
          'This account is disabled. Ask an administrator to re-enable it.',
        );
      }

      // Local administrators are never demoted by Entra group checks.
      let targetRole: Role;
      if (existing?.role === 'admin') {
        targetRole = 'admin';
      } else if (isTechnician) {
        targetRole = 'technician';
      } else if (existing && existing.passwordHash !== null && existing.role === 'technician') {
        // Do not downgrade a local-password technician account via SSO; require group or password.
        throw new EntraAuthError(
          'not_in_group',
          'Your Microsoft account is not in the technician group. Sign in with your local password, or ask an administrator to add you to the group.',
        );
      } else if (portalEnabled) {
        targetRole = 'end_user';
      } else {
        throw new EntraAuthError(
          'not_in_group',
          'Your Microsoft account is not in the technician group. Ask an administrator to add you, or sign in with a local account.',
        );
      }

      const now = new Date();
      if (existing) {
        // Never overwrite another user's linked entraSubject if email collided.
        if (existing.entraSubject && existing.entraSubject !== subject) {
          throw new EntraAuthError(
            'sso_subject_mismatch',
            'That email address is already linked to a different Microsoft account. Ask an administrator for help.',
          );
        }
        const [updated] = await tx
          .update(users)
          .set({
            name,
            role: targetRole,
            entraSubject: subject,
            updatedAt: now,
          })
          .where(eq(users.id, existing.id))
          .returning();
        if (!updated) throw new Error('user update returned no row');
        if (targetRole === 'end_user') await ensureRequester(tx, email, name);
        return {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          role: updated.role,
        };
      }

      const [created] = await tx
        .insert(users)
        .values({
          email,
          name,
          role: targetRole,
          entraSubject: subject,
          passwordHash: null,
        })
        .returning();
      if (!created) throw new Error('user insert returned no row');
      if (targetRole === 'end_user') await ensureRequester(tx, email, name);
      return {
        id: created.id,
        email: created.email,
        name: created.name,
        role: created.role,
      };
    });
  }
}

async function ensureRequester(tx: Tx, email: string, name: string): Promise<void> {
  await tx
    .insert(requesters)
    .values({ email, name })
    .onConflictDoNothing({ target: requesters.email });
}
