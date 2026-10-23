import { STAFF_ROLES, type RouteAccess } from '../auth/http.js';
import type { SessionStore } from '../auth/sessions.js';
import type { SetupToken } from '../auth/setup-token.js';
import type { TokenStore } from '../auth/tokens.js';
import type { AttachmentStore } from '../attachments.js';
import type { Db } from '../db/client.js';
import type { MailService } from '../mail/service.js';

export type RouteDeps = {
  db: Db;
  sessions: SessionStore;
  tokens: TokenStore;
  setupToken: SetupToken;
  mail: MailService;
  attachments: AttachmentStore;
};

/** Login and setup are rate limited per client IP, on top of per-account lockout. */
export const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/** Arbitrary key for the advisory lock that serializes first-run setup and admin-count checks. */
export const USERS_LOCK_KEY = 4_830_117;

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const hit = e.code === '23505' ? e : e.cause?.code === '23505' ? e.cause : undefined;
  return hit !== undefined && (constraint === undefined || hit.constraint === constraint);
}

export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23503' || e.cause?.code === '23503';
}

/** Signed-in administrators only; no token scope reaches these. */
export const ADMIN_ONLY: RouteAccess = { roles: ['admin'] };
export const ASSETS_READ: RouteAccess = { roles: STAFF_ROLES, scopes: ['assets:read'] };
export const ASSETS_WRITE: RouteAccess = { roles: STAFF_ROLES, scopes: ['assets:write'] };
/** Signed-in staff only; no token scope reaches these. */
export const STAFF_ONLY: RouteAccess = { roles: STAFF_ROLES };
export const TICKETS_READ: RouteAccess = { roles: STAFF_ROLES, scopes: ['tickets:read'] };
export const TICKETS_WRITE: RouteAccess = { roles: STAFF_ROLES, scopes: ['tickets:write'] };
