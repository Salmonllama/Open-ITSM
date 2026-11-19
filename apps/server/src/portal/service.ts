import { createHash, randomBytes } from 'node:crypto';
import type { PortalSettings, User } from '@open-itsm/shared';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { audit } from '../audit.js';
import type { EntraService } from '../auth/entra.js';
import type { SessionStore } from '../auth/sessions.js';
import type { Db } from '../db/client.js';
import { loginLinks, requesters, sessions, settings, users } from '../db/schema.js';
import type { MailService } from '../mail/service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const PORTAL_CONFIG_KEY = 'portal';
export const LOGIN_LINK_TTL_MS = 15 * 60 * 1000;

type StoredPortalConfig = {
  enabled: boolean;
};

export class PortalDisabledError extends Error {}
export class MailNotConnectedError extends Error {}
export class InvalidLoginLinkError extends Error {}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Optional end-user portal settings and emailed one-time sign-in links.
 * Off by default. When switched off, active end-user sessions are revoked immediately.
 */
export class PortalService {
  constructor(
    readonly db: Db,
    private readonly deps: {
      entra: EntraService;
      mail: MailService;
      siteUrl: string | null;
    },
    private readonly log: Logger,
  ) {}

  get siteUrl(): string | null {
    return this.deps.siteUrl;
  }

  async isEnabled(): Promise<boolean> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PORTAL_CONFIG_KEY));
    return (row?.value as StoredPortalConfig | undefined)?.enabled === true;
  }

  async settings(): Promise<PortalSettings> {
    const [enabled, entraEnabled, mailConnected] = await Promise.all([
      this.isEnabled(),
      this.deps.entra.isEnabled(),
      this.deps.mail.canSend(),
    ]);
    return { enabled, entraEnabled, mailConnected };
  }

  async save(enabled: boolean, actorUserId: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx: Tx) => {
      await tx
        .insert(settings)
        .values({
          key: PORTAL_CONFIG_KEY,
          value: { enabled } satisfies StoredPortalConfig,
          updatedAt: now,
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: {
            value: { enabled } satisfies StoredPortalConfig,
            updatedAt: now,
            updatedBy: actorUserId,
          },
        });

      if (!enabled) {
        // Revoke active end-user sessions and invalidate unused login links immediately.
        const endUsers = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.role, 'end_user'));
        for (const u of endUsers) {
          await tx
            .update(sessions)
            .set({ revokedAt: now })
            .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
        }
        await tx.update(loginLinks).set({ usedAt: now }).where(isNull(loginLinks.usedAt));
      }
    });
  }

  /**
   * Issues and emails a single-use sign-in link to an end-user email address.
   * Silently skips staff accounts and disabled users so the response never leaks account status.
   */
  async requestEmailLink(email: string, origin: string, ip: string): Promise<void> {
    if (!(await this.isEnabled())) throw new PortalDisabledError();
    if (!(await this.deps.mail.canSend())) throw new MailNotConnectedError();

    const [existing] = await this.db.select().from(users).where(eq(users.email, email));
    if (existing && (existing.role !== 'end_user' || existing.disabledAt !== null)) {
      // Never send a magic link to a staff account or a disabled user.
      await audit(this.db, {
        action: 'login_link.requested',
        targetUserId: existing.id,
        ip,
        details: { email, skipped: existing.disabledAt ? 'disabled' : 'staff_account' },
      });
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LOGIN_LINK_TTL_MS);
    await this.db.insert(loginLinks).values({
      email,
      tokenHash: hashToken(token),
      expiresAt,
      ip,
    });

    const url = `${origin}/login/link?token=${encodeURIComponent(token)}`;
    const body = [
      'Open this link to sign in to Open ITSM and view your open support tickets:',
      '',
      url,
      '',
      'This link works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.',
    ].join('\n');

    await this.deps.mail.sendSystemEmail(email, 'Your Open ITSM sign-in link', body);
    await audit(this.db, {
      action: 'login_link.requested',
      targetUserId: existing?.id ?? null,
      ip,
      details: { email },
    });
  }

  /**
   * Redeems a single-use sign-in token, provisioning or reusing the end_user account and
   * creating a server-side session.
   */
  async redeemEmailLink(
    token: string,
    sessionStore: SessionStore,
    meta: { ip: string; userAgent?: string | undefined },
  ): Promise<{ user: User; session: { token: string; csrfToken: string; expiresAt: Date } }> {
    if (!(await this.isEnabled())) throw new PortalDisabledError();
    const now = new Date();
    const tokenHash = hashToken(token);

    const [consumed] = await this.db
      .update(loginLinks)
      .set({ usedAt: now })
      .where(
        and(
          eq(loginLinks.tokenHash, tokenHash),
          isNull(loginLinks.usedAt),
          gt(loginLinks.expiresAt, now),
        ),
      )
      .returning({ email: loginLinks.email });

    if (!consumed) {
      await audit(this.db, {
        action: 'login_link.failed',
        ip: meta.ip,
        details: { reason: 'invalid_or_expired' },
      });
      throw new InvalidLoginLinkError();
    }

    const email = consumed.email;
    const user = await this.db.transaction(async (tx: Tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.email, email));
      if (existing) {
        if (existing.role !== 'end_user' || existing.disabledAt !== null) {
          throw new InvalidLoginLinkError();
        }
        await tx
          .insert(requesters)
          .values({ email, name: existing.name })
          .onConflictDoNothing({ target: requesters.email });
        return {
          id: existing.id,
          email: existing.email,
          name: existing.name,
          role: existing.role,
        };
      }

      const [reqRow] = await tx.select().from(requesters).where(eq(requesters.email, email));
      const name = reqRow?.name.trim() ? reqRow.name.trim() : email;
      const [created] = await tx
        .insert(users)
        .values({ email, name, role: 'end_user', passwordHash: null })
        .returning();
      if (!created) throw new Error('end_user insert returned no row');
      if (!reqRow) {
        await tx
          .insert(requesters)
          .values({ email, name })
          .onConflictDoNothing({ target: requesters.email });
      }
      return {
        id: created.id,
        email: created.email,
        name: created.name,
        role: created.role,
      };
    });

    const createdSession = await sessionStore.create(user.id, meta);
    await audit(this.db, {
      action: 'login.succeeded',
      actorUserId: user.id,
      ip: meta.ip,
      details: { via: 'email_link', role: user.role },
    });
    return { user, session: createdSession };
  }

  /** Removes expired or used sign-in links older than a day. */
  async cleanupExpiredLinks(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const removed = await this.db
      .delete(loginLinks)
      .where(lt(loginLinks.expiresAt, cutoff))
      .returning({ id: loginLinks.id });
    if (removed.length > 0) this.log.info({ removed: removed.length }, 'removed old login links');
    return removed.length;
  }
}
