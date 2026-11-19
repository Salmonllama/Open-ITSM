import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { TEST_GRAPH_URL, TEST_LOGIN_URL } from '../helpers/app.js';

export type FakeEntraUser = {
  oid: string;
  email: string;
  name: string;
  /** Group IDs this user belongs to. */
  groups: string[];
  /** Simulate Entra ID group overage: omit `groups` from the ID token and emit `_claim_names`. */
  overage?: boolean;
};

type PendingCode = {
  user: FakeEntraUser;
  nonce: string | null;
  codeChallenge: string | null;
  redirectUri: string;
  clientId: string;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Stand-in Microsoft Entra ID OIDC provider and Graph `/me/checkMemberGroups` endpoint.
 * Signs real RS256 ID tokens and verifies PKCE S256 and client secrets so `openid-client`
 * runs its full cryptographic verification without touching the internet.
 */
export class FakeEntra {
  readonly tenantId = '11111111-1111-4111-8111-111111111111';
  readonly clientId = '22222222-2222-4222-8222-222222222222';
  readonly clientSecret = 'entra-super-secret-value';
  readonly techGroupId = '33333333-3333-4333-8333-333333333333';

  private readonly kid = 'test-key-1';
  private readonly privateKey;
  private readonly publicJwk;
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, FakeEntraUser>();

  /** Set to simulate Graph rejecting checkMemberGroups (e.g. missing GroupMember.Read.All). */
  graphErrorStatus: number | null = null;
  /** Set to simulate discovery/network failure. */
  discoveryFails = false;
  /** Counts Graph fallback calls so tests can verify overage triggered Graph. */
  graphCheckCalls = 0;

  constructor() {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.publicJwk = { ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' };
  }

  private get issuer(): string {
    return `${TEST_LOGIN_URL}/${this.tenantId}/v2.0`;
  }

  /** Simulates the user approving sign-in at Microsoft's authorize URL and returns the callback URL. */
  authorize(authorizeUrl: string, user: FakeEntraUser): string {
    const url = new URL(authorizeUrl);
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    const codeChallenge = url.searchParams.get('code_challenge');
    const redirectUri = url.searchParams.get('redirect_uri');
    const clientId = url.searchParams.get('client_id');
    if (!redirectUri || !clientId) throw new Error('missing redirect_uri or client_id');
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { user, nonce, codeChallenge, redirectUri, clientId });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    if (state) callback.searchParams.set('state', state);
    return callback.pathname + callback.search;
  }

  private signJwt(payload: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.kid }));
    const body = b64url(JSON.stringify(payload));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    const sig = signer.sign(this.privateKey).toString('base64url');
    return `${header}.${body}.${sig}`;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    // OIDC Discovery
    if (url.endsWith('/.well-known/openid-configuration')) {
      if (this.discoveryFails) {
        return new Response(JSON.stringify({ error: 'tenant_not_found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (!url.startsWith(`${this.issuer}/`)) {
        return new Response(
          JSON.stringify({
            error: 'invalid_tenant',
            error_description: 'AADSTS90002: Tenant not found',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          issuer: this.issuer,
          authorization_endpoint: `${TEST_LOGIN_URL}/${this.tenantId}/oauth2/v2.0/authorize`,
          token_endpoint: `${TEST_LOGIN_URL}/${this.tenantId}/oauth2/v2.0/token`,
          jwks_uri: `${TEST_LOGIN_URL}/${this.tenantId}/discovery/v2.0/keys`,
          response_types_supported: ['code'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // JWKS
    if (url === `${TEST_LOGIN_URL}/${this.tenantId}/discovery/v2.0/keys`) {
      return new Response(JSON.stringify({ keys: [this.publicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Token endpoint
    if (method === 'POST' && url === `${TEST_LOGIN_URL}/${this.tenantId}/oauth2/v2.0/token`) {
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : '';
      const params = new URLSearchParams(bodyText);
      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');
      if (clientId !== this.clientId) {
        return new Response(
          JSON.stringify({
            error: 'unauthorized_client',
            error_description: 'AADSTS700016: Application was not found',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (clientSecret !== this.clientSecret) {
        return new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: 'AADSTS7000215: Invalid client secret provided',
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      const code = params.get('code') ?? '';
      const pending = this.codes.get(code);
      this.codes.delete(code);
      if (!pending) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const verifier = params.get('code_verifier') ?? '';
      const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
      if (pending.codeChallenge && expectedChallenge !== pending.codeChallenge) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: this.issuer,
        aud: this.clientId,
        sub: `sub-${pending.user.oid}`,
        oid: pending.user.oid,
        email: pending.user.email,
        preferred_username: pending.user.email,
        name: pending.user.name,
        iat: now,
        exp: now + 3600,
        ...(pending.nonce ? { nonce: pending.nonce } : {}),
      };
      if (pending.user.overage) {
        claims._claim_names = { groups: 'src1' };
        claims._claim_sources = {
          src1: { endpoint: `${TEST_GRAPH_URL}/users/${pending.user.oid}/getMemberObjects` },
        };
        claims.hasgroups = true;
      } else {
        claims.groups = pending.user.groups;
      }
      const accessToken = `at-${randomBytes(16).toString('hex')}`;
      this.accessTokens.set(accessToken, pending.user);
      return new Response(
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: accessToken,
          id_token: this.signJwt(claims),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Graph /me/checkMemberGroups fallback
    if (method === 'POST' && url === `${TEST_GRAPH_URL}/me/checkMemberGroups`) {
      this.graphCheckCalls++;
      if (this.graphErrorStatus) {
        return new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied' } }), {
          status: this.graphErrorStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      const headers = new Headers(init?.headers);
      const token = headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = this.accessTokens.get(token);
      if (!user) {
        return new Response(JSON.stringify({ error: { code: 'InvalidAuthenticationToken' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { groupIds?: string[] };
      const requested = new Set((body.groupIds ?? []).map((g) => g.toLowerCase()));
      const matching = user.groups.filter((g) => requested.has(g.toLowerCase()));
      return new Response(JSON.stringify({ value: matching }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `unexpected request: ${method} ${url}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
}
