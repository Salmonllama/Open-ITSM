import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recoveryIo } from './helpers/io.js';
import { makeApp, sessionCookie, TEST_SESSION_SECRET, TEST_SETUP_TOKEN } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { SESSION_COOKIE } from '../src/auth/http.js';
import { runRecovery } from '../src/recovery.js';

const admin = { name: 'Ada Admin', email: 'Ada@Example.com', password: 'correct horse battery' };

// M1 acceptance: a fresh install goes wizard, then login; a second wizard visit is refused;
// the CLI resets a password.
describe.skipIf(!testDatabaseUrl)('M1 acceptance: setup wizard, login and recovery', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('runs the wizard once, signs in, refuses a second wizard, and recovers via the CLI', async () => {
    const app = await makeApp({ db: t.db });

    // Fresh install: setup is required.
    let res = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.json()).toEqual({ required: true });

    // A wrong token is refused and creates nothing.
    res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...admin, token: 'wrong-token' },
    });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().required).toBe(
      true,
    );

    // The wizard with the logged token creates the admin and signs them in.
    res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...admin, token: TEST_SETUP_TOKEN },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: 'ada@example.com', role: 'admin' });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });

    // A second wizard visit is refused, even with the right token.
    res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...admin, email: 'intruder@example.com', token: TEST_SETUP_TOKEN },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('setup_complete');
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({
      required: false,
    });

    // Login works with the wizard's credentials (email is case-insensitive).
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ADA@example.com', password: admin.password },
    });
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);
    res = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.json().user.email).toBe('ada@example.com');

    // The CLI resets the password; the old one stops working, the new one works,
    // and existing sessions are signed out.
    const io = recoveryIo();
    const code = await runRecovery(
      ['reset-password', 'ada@example.com'],
      { db: t.db, sessionSecret: TEST_SESSION_SECRET },
      io,
    );
    expect(code).toBe(0);
    const newPassword = io.lines.join('\n').match(/New password for ada@example\.com: (\S+)/)?.[1];
    expect(newPassword).toBeDefined();

    res = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(401);

    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.password },
    });
    expect(res.statusCode).toBe(401);

    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: newPassword },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('records setup, sign-ins and the CLI reset in the audit log', async () => {
    const { rows } = await t.pool.query<{ action: string }>(
      'select action from audit_log order by id',
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'setup.completed',
        'login.succeeded',
        'login.failed',
        'user.password_reset',
      ]),
    );
  });
});
