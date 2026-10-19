import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenScope } from '@open-itsm/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiTokens, serviceAccounts } from '../db/schema.js';

export const TOKEN_PREFIX = 'oitsm_';
/** `oitsm_<16 hex token id>_<64 hex secret>`; the secret carries 256 random bits. */
export const TOKEN_PATTERN = /^oitsm_([0-9a-f]{16})_([0-9a-f]{64})$/;
/** Anything shaped like a token, for spotting one sent somewhere it must not be. */
export const TOKEN_LIKE = /oitsm_[0-9a-f]{16}_[0-9a-f]{64}/;

/** last_used_at is refreshed at most this often, to avoid a write on every request. */
const TOUCH_INTERVAL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ActiveToken = {
  id: string;
  publicId: string;
  scopes: TokenScope[];
  serviceAccount: { id: string; name: string };
};

export type TokenFailure = 'malformed' | 'unknown' | 'revoked' | 'expired' | 'account_disabled';

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateToken() {
  const publicId = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('hex');
  return {
    token: `${TOKEN_PREFIX}${publicId}_${secret}`,
    publicId,
    secretHash: hashSecret(secret),
  };
}

export class TokenStore {
  constructor(private readonly db: Db) {}

  async create(input: {
    serviceAccountId: string;
    scopes: TokenScope[];
    expiresInDays: number;
    createdByUserId: string;
    executor?: Pick<Db, 'insert'>;
  }) {
    const { token, publicId, secretHash } = generateToken();
    // created_at is set here, not by the database, so the one-year check compares like with like.
    const createdAt = new Date();
    const [row] = await (input.executor ?? this.db)
      .insert(apiTokens)
      .values({
        serviceAccountId: input.serviceAccountId,
        publicId,
        secretHash,
        scopes: input.scopes,
        createdByUserId: input.createdByUserId,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + input.expiresInDays * DAY_MS),
      })
      .returning();
    if (!row) throw new Error('insert returned no row');
    return { token, row };
  }

  /** Checks a bearer token; the secret is compared by hash in constant time. */
  async verify(
    token: string,
  ): Promise<
    { ok: true; token: ActiveToken } | { ok: false; reason: TokenFailure; publicId?: string }
  > {
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return { ok: false, reason: 'malformed' };
    const [, publicId = '', secret = ''] = match;
    const [row] = await this.db
      .select({
        id: apiTokens.id,
        secretHash: apiTokens.secretHash,
        scopes: apiTokens.scopes,
        expiresAt: apiTokens.expiresAt,
        revokedAt: apiTokens.revokedAt,
        lastUsedAt: apiTokens.lastUsedAt,
        account: {
          id: serviceAccounts.id,
          name: serviceAccounts.name,
          disabledAt: serviceAccounts.disabledAt,
        },
      })
      .from(apiTokens)
      .innerJoin(serviceAccounts, eq(serviceAccounts.id, apiTokens.serviceAccountId))
      .where(eq(apiTokens.publicId, publicId));

    // Hash even when the ID is unknown, so timing does not reveal which IDs exist.
    const given = Buffer.from(hashSecret(secret), 'hex');
    const stored = Buffer.from(row?.secretHash ?? '0'.repeat(64), 'hex');
    const secretMatches = timingSafeEqual(given, stored);
    if (!row || !secretMatches) return { ok: false, reason: 'unknown', publicId };
    if (row.revokedAt) return { ok: false, reason: 'revoked', publicId };
    const now = new Date();
    if (row.expiresAt <= now) return { ok: false, reason: 'expired', publicId };
    if (row.account.disabledAt) return { ok: false, reason: 'account_disabled', publicId };

    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
    }
    return {
      ok: true,
      token: {
        id: row.id,
        publicId,
        scopes: row.scopes as TokenScope[],
        serviceAccount: { id: row.account.id, name: row.account.name },
      },
    };
  }

  async revoke(tokenId: string, executor: Pick<Db, 'update'> = this.db): Promise<boolean> {
    const rows = await executor
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(sql`${apiTokens.id} = ${tokenId} and ${apiTokens.revokedAt} is null`)
      .returning({ id: apiTokens.id });
    return rows.length > 0;
  }
}

/**
 * Fixed-window counter kept in memory. One app process serves an install, so a shared store is
 * not needed; counts reset on restart.
 */
export class WindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Records a hit and returns whether the key is now over the limit. */
  hit(key: string, now = Date.now()): boolean {
    const entry = this.current(key, now) ?? { count: 0, resetAt: now + this.windowMs };
    entry.count += 1;
    this.hits.set(key, entry);
    if (this.hits.size > 10_000) this.sweep(now);
    return entry.count > this.max;
  }

  /** Whether the key is over the limit, without recording a hit. */
  blocked(key: string, now = Date.now()): boolean {
    return (this.current(key, now)?.count ?? 0) >= this.max;
  }

  private current(key: string, now: number) {
    const entry = this.hits.get(key);
    if (entry && entry.resetAt <= now) {
      this.hits.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
