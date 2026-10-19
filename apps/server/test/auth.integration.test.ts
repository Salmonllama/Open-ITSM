import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/http.js';
import { sessions, users } from '../src/db/schema.js';
import { LOCKOUT_THRESHOLD } from '../src/routes/auth.js';
import { makeApp } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, PASSWORD, signIn } from './helpers/seed.js';

describe.skipIf(!testDatabaseUrl)('sign-in security', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await app?.close();
    // A fresh app per test resets the in-memory per-IP rate limiter.
    app = await makeApp({ db: t.db });
  });

  const login = (email: string, password: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    await createUser(t.db, 'same@example.com', 'technician');
    const unknown = await login('nobody@example.com', PASSWORD);
    const wrong = await login('same@example.com', 'not the right password');
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('locks an account after repeated failures, even for the right password', async () => {
    await createUser(t.db, 'lock@example.com', 'technician');
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      expect((await login('lock@example.com', 'wrong password!!')).statusCode).toBe(401);
    }
    const locked = await login('lock@example.com', PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('locked');

    // Once the lock expires the right password works and the counter is reset.
    await t.db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.email, 'lock@example.com'));
    expect((await login('lock@example.com', PASSWORD)).statusCode).toBe(200);
    const [row] = await t.db.select().from(users).where(eq(users.email, 'lock@example.com'));
    expect(row?.failedLoginCount).toBe(0);
  });

  it('rate limits sign-in attempts per client', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await login('flood@example.com', 'x')).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('refuses disabled accounts', async () => {
    const user = await createUser(t.db, 'disabled@example.com', 'technician');
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect((await login('disabled@example.com', PASSWORD)).statusCode).toBe(401);
  });

  it('refuses a cross-origin sign-in', async () => {
    await createUser(t.db, 'origin@example.com', 'technician');
    const res = await login('origin@example.com', PASSWORD, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    const same = await login('origin@example.com', PASSWORD, { origin: 'http://localhost:80' });
    expect(same.statusCode).toBe(200);
  });

  it('requires the CSRF token on authenticated writes', async () => {
    await createUser(t.db, 'csrf@example.com', 'technician');
    const s = await signIn(app, 'csrf@example.com');
    const without = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: s.cookie },
    });
    expect(without.statusCode).toBe(403);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: s.cookie },
      headers: { 'x-csrf-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(403);
    expect((await s.request({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
  });

  it('revokes the session on logout', async () => {
    await createUser(t.db, 'logout@example.com', 'technician');
    const s = await signIn(app, 'logout@example.com');
    await s.request({ method: 'POST', url: '/api/auth/logout' });
    expect((await s.request({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(401);
  });

  it('expires sessions after 12 hours idle and 7 days in total', async () => {
    const user = await createUser(t.db, 'expiry@example.com', 'technician');
    const idle = await signIn(app, 'expiry@example.com');
    const old = await signIn(app, 'expiry@example.com');
    const [idleRow, oldRow] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id))
      .orderBy(sessions.createdAt);
    if (!idleRow || !oldRow) throw new Error('expected two sessions');
    await t.db
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - 12 * 3600_000 - 1000) })
      .where(eq(sessions.id, idleRow.id));
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, oldRow.id));
    expect((await idle.request({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(401);
    expect((await old.request({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const user = await createUser(t.db, 'hash@example.com', 'technician');
    const s = await signIn(app, 'hash@example.com');
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows.some((r) => r.id === s.cookie)).toBe(false);
  });

  it('allows only one concurrent setup to win', async () => {
    const fresh = await createTestDatabase();
    try {
      const a = await makeApp({ db: fresh.db });
      const payload = (email: string) => ({
        token: 'test-setup-token',
        name: 'Admin',
        email,
        password: PASSWORD,
      });
      const results = await Promise.all([
        a.inject({ method: 'POST', url: '/api/setup', payload: payload('one@example.com') }),
        a.inject({ method: 'POST', url: '/api/setup', payload: payload('two@example.com') }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const { rows } = await fresh.pool.query('select count(*)::int as n from users');
      expect(rows[0].n).toBe(1);
      await a.close();
    } finally {
      await fresh.drop();
    }
  });
});
