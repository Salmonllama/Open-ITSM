import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** last_seen_at is refreshed at most this often, to avoid a write on every request. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'technician' | 'end_user';
};

export type ActiveSession = { id: string; csrfToken: string; user: SessionUser };

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  /** The database keeps only an HMAC of the token, so a leaked table cannot be replayed. */
  private idFor(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex');
  }

  async create(userId: string, meta: { ip?: string; userAgent?: string }) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_MAX_MS);
    await this.db.insert(sessions).values({
      id: this.idFor(token),
      userId,
      csrfToken,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
    });
    return { token, csrfToken, expiresAt };
  }

  /** Returns the session if it is unrevoked, inside both limits, and its user is enabled. */
  async find(token: string): Promise<ActiveSession | undefined> {
    const id = this.idFor(token);
    const now = new Date();
    const [row] = await this.db
      .select({
        id: sessions.id,
        csrfToken: sessions.csrfToken,
        lastSeenAt: sessions.lastSeenAt,
        user: { id: users.id, email: users.email, name: users.name, role: users.role },
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, id),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          gt(sessions.lastSeenAt, new Date(now.getTime() - SESSION_IDLE_MS)),
          isNull(users.disabledAt),
        ),
      );
    if (!row) return undefined;
    if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
    }
    return { id: row.id, csrfToken: row.csrfToken, user: row.user };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  /** Revokes every open session of a user, optionally keeping one (the caller's own). */
  async revokeAllForUser(
    userId: string,
    executor: Pick<Db, 'update'> = this.db,
    exceptSessionId?: string,
  ): Promise<void> {
    await executor
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
        ),
      );
  }
}
