import type { SessionStore } from '../auth/sessions.js';
import type { SetupToken } from '../auth/setup-token.js';
import type { Db } from '../db/client.js';

export type RouteDeps = {
  db: Db;
  sessions: SessionStore;
  setupToken: SetupToken;
};

/** Login and setup are rate limited per client IP, on top of per-account lockout. */
export const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/** Arbitrary key for the advisory lock that serializes first-run setup and admin-count checks. */
export const USERS_LOCK_KEY = 4_830_117;
