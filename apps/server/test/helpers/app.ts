import type { LightMyRequestResponse } from 'fastify';
import { buildApp, type AppOptions } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth/http.js';
import { SetupToken } from '../../src/auth/setup-token.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';

export const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-characters';
export const TEST_SETUP_TOKEN = 'test-setup-token';

const ok = () => Promise.resolve(true);

/** A Db whose pool never connects, for tests that do not touch the database. */
export function unusedDb(): Db {
  return createDb(createPool('postgres://unused@127.0.0.1:1/unused'));
}

export async function makeApp(overrides: Partial<AppOptions> = {}) {
  return buildApp({
    version: '1.2.3',
    logger: false,
    checks: { database: ok, queue: ok },
    db: overrides.db ?? unusedDb(),
    sessionSecret: TEST_SESSION_SECRET,
    setupToken: new SetupToken(TEST_SETUP_TOKEN),
    ...overrides,
  });
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('response set no session cookie');
  return cookie.value;
}
