import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { AttachmentStore } from '../../src/attachments.js';
import { buildApp, type AppOptions } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth/http.js';
import { SetupToken } from '../../src/auth/setup-token.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { MailService, type MailOptions } from '../../src/mail/service.js';

export const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-characters';
export const TEST_SETUP_TOKEN = 'test-setup-token';

const ok = () => Promise.resolve(true);

/** A Db whose pool never connects, for tests that do not touch the database. */
export function unusedDb(): Db {
  return createDb(createPool('postgres://unused@127.0.0.1:1/unused'));
}

export const TEST_GRAPH_URL = 'https://graph.test/v1.0';
export const TEST_LOGIN_URL = 'https://login.test';

/** A mailbox service against a Graph stand-in (`fetch`), with files in a temporary folder. */
export function makeMail(db: Db, options: Partial<MailOptions> = {}) {
  const store =
    options.store ?? new AttachmentStore(mkdtempSync(path.join(tmpdir(), 'open-itsm-files-')));
  const mail = new MailService(
    db,
    {
      secretKey: randomBytes(32),
      graphUrl: TEST_GRAPH_URL,
      loginUrl: TEST_LOGIN_URL,
      fetch: () => Promise.reject(new Error('no Graph stand-in in this test')),
      ...options,
      store,
    },
    pino({ level: 'silent' }),
  );
  return { mail, store };
}

export async function makeApp(overrides: Partial<AppOptions> = {}) {
  const db = overrides.db ?? unusedDb();
  const { mail, store } = makeMail(db);
  return buildApp({
    version: '1.2.3',
    logger: false,
    checks: { database: ok, queue: ok },
    db,
    mail,
    attachments: store,
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
