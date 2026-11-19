import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OIDC_COOKIE } from '../src/auth/entra.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../src/auth/http.js';
import { auditLog, users } from '../src/db/schema.js';
import { runRecovery } from '../src/recovery.js';
import { FakeEntra, type FakeEntraUser } from './fixtures/entra.js';
import {
  makeApp,
  makeEntra,
  sessionCookie,
  TEST_SESSION_SECRET,
  TEST_SETUP_TOKEN,
} from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('Entra ID single sign-on (M9)', () => {
  let tdb: TestDatabase;
  let fake: FakeEntra;
  let app: FastifyInstance;
  let adminCookie: string;
  let adminCsrf: string;

  async function saveSso(overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/sso',
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: {
        tenantId: fake.tenantId,
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
        technicianGroupId: fake.techGroupId,
        secretExpiresOn: '2028-06-01',
        enabled: true,
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  let nextIp = 1;
  const freshIp = () => `10.0.0.${nextIp++}`;

  async function completeEntraLogin(user: FakeEntraUser, redirect?: string) {
    const ip = freshIp();
    const startUrl = redirect
      ? `/api/auth/entra/start?redirect=${encodeURIComponent(redirect)}`
      : '/api/auth/entra/start';
    const start = await app.inject({
      method: 'GET',
      url: startUrl,
      headers: { 'x-forwarded-for': ip },
    });
    expect(start.statusCode).toBe(302);
    const authorizeUrl = start.headers.location as string;
    const oidc = start.cookies.find((c) => c.name === OIDC_COOKIE);
    if (!oidc) throw new Error('expected OIDC state cookie');
    const callbackPath = fake.authorize(authorizeUrl, user);
    return app.inject({
      method: 'GET',
      url: callbackPath,
      headers: { 'x-forwarded-for': ip },
      cookies: { [OIDC_COOKIE]: oidc.value },
    });
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    fake = new FakeEntra();
    app = await makeApp({
      db: tdb.db,
      entra: makeEntra(tdb.db, { fetch: fake.fetch }),
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        token: TEST_SETUP_TOKEN,
        name: 'Local Admin',
        email: 'admin@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(setup.statusCode).toBe(201);
    adminCookie = sessionCookie(setup);
    adminCsrf = setup.json().csrfToken;
  });

  beforeEach(async () => {
    fake.discoveryFails = false;
    fake.graphErrorStatus = null;
    fake.graphCheckCalls = 0;
    await app.inject({
      method: 'DELETE',
      url: '/api/settings/sso',
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
    });
  });

  afterAll(async () => {
    await app.close();
    await tdb.drop();
  });

  it('acceptance: group members sign in via Entra ID while local accounts keep working even when SSO is misconfigured', async () => {
    // Initially off: auth methods shows entra disabled.
    const before = await app.inject({ method: 'GET', url: '/api/auth/methods' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      local: true,
      entra: { enabled: false },
      emailLink: { enabled: false },
    });

    // Admin configures and tests SSO.
    const tested = await app.inject({
      method: 'POST',
      url: '/api/settings/sso/test',
      cookies: { [SESSION_COOKIE]: adminCookie },
      headers: { [CSRF_HEADER]: adminCsrf },
      payload: {
        tenantId: fake.tenantId,
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
        technicianGroupId: fake.techGroupId,
        enabled: true,
      },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().ok).toBe(true);

    const saved = await saveSso();
    expect(saved.secretSet).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(fake.clientSecret);

    const methods = await app.inject({ method: 'GET', url: '/api/auth/methods' });
    expect(methods.json().entra.enabled).toBe(true);

    // Technician group member signs in through OIDC + PKCE.
    const callback = await completeEntraLogin(
      {
        oid: 'oid-tech-1',
        email: 'alex.tech@example.com',
        name: 'Alex Tech',
        groups: [fake.techGroupId],
      },
      '/tickets',
    );
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/tickets');
    const techCookie = sessionCookie(callback);

    const sess = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: { [SESSION_COOKIE]: techCookie },
    });
    expect(sess.statusCode).toBe(200);
    expect(sess.json().user).toMatchObject({
      email: 'alex.tech@example.com',
      name: 'Alex Tech',
      role: 'technician',
    });

    // Technician can reach technician endpoints (e.g. tickets) but not admin settings.
    const ticketsRes = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      cookies: { [SESSION_COOKIE]: techCookie },
    });
    expect(ticketsRes.statusCode).toBe(200);
    const adminRes = await app.inject({
      method: 'GET',
      url: '/api/settings/sso',
      cookies: { [SESSION_COOKIE]: techCookie },
    });
    expect(adminRes.statusCode).toBe(403);

    // Misconfigure SSO (bad client secret) -> Entra sign-in fails gracefully to /login?ssoError=...
    await saveSso({ clientSecret: 'wrong-secret' });
    const badCallback = await completeEntraLogin({
      oid: 'oid-tech-1',
      email: 'alex.tech@example.com',
      name: 'Alex Tech',
      groups: [fake.techGroupId],
    });
    expect(badCallback.statusCode).toBe(302);
    expect(badCallback.headers.location).toMatch(/^\/login\?ssoError=/);

    // Local login STILL works even while SSO is misconfigured and failing discovery!
    fake.discoveryFails = true;
    const localLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(localLogin.statusCode).toBe(200);
    expect(localLogin.json().user.role).toBe('admin');
  });

  it('falls back to Microsoft Graph checkMemberGroups when the token has group overage', async () => {
    await saveSso();
    const memberRes = await completeEntraLogin({
      oid: 'oid-overage-member',
      email: 'overage.tech@example.com',
      name: 'Overage Tech',
      groups: [fake.techGroupId],
      overage: true,
    });
    expect(memberRes.statusCode).toBe(302);
    expect(memberRes.headers.location).toBe('/');
    expect(fake.graphCheckCalls).toBe(1);

    const sess = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: { [SESSION_COOKIE]: sessionCookie(memberRes) },
    });
    expect(sess.json().user.role).toBe('technician');

    // Non-member with overage is refused.
    const outsiderRes = await completeEntraLogin({
      oid: 'oid-overage-outsider',
      email: 'outsider@example.com',
      name: 'Outsider',
      groups: ['99999999-9999-4999-8999-999999999999'],
      overage: true,
    });
    expect(outsiderRes.statusCode).toBe(302);
    expect(outsiderRes.headers.location).toMatch(/^\/login\?ssoError=/);
    expect(fake.graphCheckCalls).toBe(2);

    // Graph 403 produces a clear admin-actionable error and does not sign in.
    fake.graphErrorStatus = 403;
    const deniedRes = await completeEntraLogin({
      oid: 'oid-overage-member',
      email: 'overage.tech@example.com',
      name: 'Overage Tech',
      groups: [fake.techGroupId],
      overage: true,
    });
    expect(deniedRes.statusCode).toBe(302);
    expect(decodeURIComponent(deniedRes.headers.location as string)).toContain(
      'GroupMember.Read.All',
    );
  });

  it('refuses non-group members, preserves local admin role, and blocks users removed from the group or disabled', async () => {
    await saveSso();

    // Non-member is refused when end-user portal is off.
    const nonMember = await completeEntraLogin({
      oid: 'oid-regular',
      email: 'regular@example.com',
      name: 'Regular Person',
      groups: [],
    });
    expect(nonMember.statusCode).toBe(302);
    expect(nonMember.headers.location).toMatch(/^\/login\?ssoError=/);

    // Existing local admin keeps admin role even if not in the technician group.
    const adminSso = await completeEntraLogin({
      oid: 'oid-local-admin',
      email: 'admin@example.com',
      name: 'Local Admin',
      groups: [],
    });
    expect(adminSso.statusCode).toBe(302);
    expect(adminSso.headers.location).toBe('/');
    const adminSess = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: { [SESSION_COOKIE]: sessionCookie(adminSso) },
    });
    expect(adminSess.json().user.role).toBe('admin');

    // Entra technician removed from the group is refused on next login.
    const first = await completeEntraLogin({
      oid: 'oid-temp-tech',
      email: 'temp.tech@example.com',
      name: 'Temp Tech',
      groups: [fake.techGroupId],
    });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/');

    const removed = await completeEntraLogin({
      oid: 'oid-temp-tech',
      email: 'temp.tech@example.com',
      name: 'Temp Tech',
      groups: [],
    });
    expect(removed.statusCode).toBe(302);
    expect(removed.headers.location).toMatch(/^\/login\?ssoError=/);

    // Disabled user is refused even if still in the technician group.
    await tdb.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.email, 'temp.tech@example.com'));
    const disabledRes = await completeEntraLogin({
      oid: 'oid-temp-tech',
      email: 'temp.tech@example.com',
      name: 'Temp Tech',
      groups: [fake.techGroupId],
    });
    expect(disabledRes.statusCode).toBe(302);
    expect(decodeURIComponent(disabledRes.headers.location as string)).toContain('disabled');
  });

  it('rejects tampered state or missing OIDC cookie and keeps stored secrets hidden', async () => {
    await saveSso();

    // Missing cookie
    const noCookie = await app.inject({
      method: 'GET',
      url: '/api/auth/entra/callback?code=abc&state=xyz',
      headers: { 'x-forwarded-for': freshIp() },
    });
    expect(noCookie.statusCode).toBe(302);
    expect(noCookie.headers.location).toMatch(/^\/login\?ssoError=/);

    // Blank secret keeps existing secret and still works
    await saveSso({ clientSecret: '' });
    const okRes = await completeEntraLogin({
      oid: 'oid-blank-secret',
      email: 'blank.secret@example.com',
      name: 'Blank Secret',
      groups: [fake.techGroupId],
    });
    expect(okRes.statusCode).toBe(302);
    expect(okRes.headers.location).toBe('/');

    // Audit log never contains the client secret
    const logs = await tdb.db.select().from(auditLog);
    expect(JSON.stringify(logs)).not.toContain(fake.clientSecret);
  });

  it('switches off Entra ID sign-in with the recovery CLI command disable-sso', async () => {
    await saveSso({ enabled: true });
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/methods' })).json().entra.enabled,
    ).toBe(true);

    const out: string[] = [];
    const err: string[] = [];
    const code = await runRecovery(
      ['disable-sso'],
      { db: tdb.db, sessionSecret: TEST_SESSION_SECRET },
      { out: (l) => out.push(l), err: (l) => err.push(l) },
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('switched off');

    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/methods' })).json().entra.enabled,
    ).toBe(false);

    // Second run reports already switched off cleanly.
    const out2: string[] = [];
    const code2 = await runRecovery(
      ['disable-sso'],
      { db: tdb.db, sessionSecret: TEST_SESSION_SECRET },
      { out: (l) => out2.push(l), err: () => {} },
    );
    expect(code2).toBe(0);
    expect(out2.join('\n')).toContain('already switched off');
  });
});
