import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/http.js';
import { loggerOptions } from '../src/logging.js';
import { makeApp } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, issueToken, signIn, withToken } from './helpers/seed.js';

describe.skipIf(!testDatabaseUrl)('API tokens and service accounts', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;

  async function auditActions(action: string) {
    const { rows } = await t.pool.query(
      'select details, actor_user_id, actor_service_account_id from audit_log where action = $1 order by at',
      [action],
    );
    return rows as {
      details: Record<string, unknown>;
      actor_user_id: string | null;
      actor_service_account_id: string | null;
    }[];
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await createUser(t.db, 'root@example.com', 'admin');
    await createUser(t.db, 'tech@example.com', 'technician');
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  beforeEach(async () => {
    await app?.close();
    app = await makeApp({ db: t.db });
  });

  it('issues a token once, in the documented format, with a 90-day default expiry', async () => {
    const admin = await signIn(app, 'root@example.com');
    const account = await admin.request({
      method: 'POST',
      url: '/api/service-accounts',
      payload: { name: 'Inventory sync', description: 'Nightly import' },
    });
    expect(account.statusCode).toBe(201);
    const res = await admin.request({
      method: 'POST',
      url: `/api/service-accounts/${account.json().id}/tokens`,
      payload: { scopes: ['assets:read', 'assets:read'] },
    });
    expect(res.statusCode).toBe(201);
    const { token, apiToken } = res.json();
    expect(token).toMatch(/^oitsm_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(apiToken.scopes).toEqual(['assets:read']);
    const days =
      (Date.parse(apiToken.expiresAt) - Date.parse(apiToken.createdAt)) / (24 * 3600 * 1000);
    expect(Math.round(days)).toBe(90);

    const list = await admin.request({ method: 'GET', url: '/api/service-accounts' });
    expect(list.body).not.toContain(token.split('_')[2]);
    const { rows } = await t.pool.query('select secret_hash from api_tokens where id = $1', [
      apiToken.id,
    ]);
    expect(rows[0].secret_hash).not.toContain(token.split('_')[2]);

    const [created] = await auditActions('token.created');
    expect(created?.details).toMatchObject({ tokenId: apiToken.id, scopes: ['assets:read'] });
  });

  it('refuses tokens longer than a year, ticket scopes and empty scopes', async () => {
    const admin = await signIn(app, 'root@example.com');
    const { accountId } = await issueToken(admin, ['assets:read']);
    for (const payload of [
      { scopes: ['assets:read'], expiresInDays: 366 },
      { scopes: ['tickets:read'] },
      { scopes: [] },
    ]) {
      const res = await admin.request({
        method: 'POST',
        url: `/api/service-accounts/${accountId}/tokens`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('keeps token and account administration for admins', async () => {
    const admin = await signIn(app, 'root@example.com');
    const { token } = await issueToken(admin, ['assets:read', 'assets:write']);
    const tech = await signIn(app, 'tech@example.com');
    expect((await tech.request({ method: 'GET', url: '/api/service-accounts' })).statusCode).toBe(
      403,
    );
    expect(
      (await withToken(app, token, { method: 'GET', url: '/api/service-accounts' })).statusCode,
    ).toBe(403);
    expect((await withToken(app, token, { method: 'GET', url: '/api/users' })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ method: 'GET', url: '/api/service-accounts' })).statusCode).toBe(
      401,
    );
  });

  it('enforces scopes: a read token can list assets but not create them', async () => {
    const admin = await signIn(app, 'root@example.com');
    const { token } = await issueToken(admin, ['assets:read']);
    const list = await withToken(app, token, { method: 'GET', url: '/api/assets' });
    expect(list.statusCode).toBe(200);
    const create = await withToken(app, token, {
      method: 'POST',
      url: '/api/asset-types',
      payload: { name: 'Laptop', prefix: 'LAP' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error).toBe('insufficient_scope');
    expect((await withToken(app, token, { method: 'GET', url: '/api/docs/json' })).statusCode).toBe(
      403,
    );
  });

  it('lets a write token change assets without a CSRF token and audits each change', async () => {
    const admin = await signIn(app, 'root@example.com');
    const { token, accountId } = await issueToken(admin, ['assets:write', 'assets:read']);
    const res = await withToken(app, token, {
      method: 'POST',
      url: '/api/asset-types',
      payload: { name: 'Token type', prefix: 'TOK' },
    });
    expect(res.statusCode).toBe(201);
    // The record is written once the response has gone out.
    const mine = await vi.waitFor(async () => {
      const rows = (await auditActions('token.request')).filter(
        (r) => r.actor_service_account_id === accountId,
      );
      expect(rows).toHaveLength(1);
      return rows;
    });
    expect(mine[0]?.details).toMatchObject({
      method: 'POST',
      route: '/api/asset-types',
      status: 201,
    });
  });

  it('refuses expired, revoked and disabled-account tokens', async () => {
    const admin = await signIn(app, 'root@example.com');
    const expired = await issueToken(admin, ['assets:read']);
    await t.pool.query(
      `update api_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1`,
      [expired.tokenId],
    );
    const revoked = await issueToken(admin, ['assets:read']);
    expect(
      (
        await admin.request({
          method: 'POST',
          url: `/api/service-accounts/${revoked.accountId}/tokens/${revoked.tokenId}/revoke`,
        })
      ).statusCode,
    ).toBe(204);
    const disabled = await issueToken(admin, ['assets:read']);
    expect(
      (
        await admin.request({
          method: 'PATCH',
          url: `/api/service-accounts/${disabled.accountId}`,
          payload: { disabled: true },
        })
      ).statusCode,
    ).toBe(200);

    for (const { token } of [expired, revoked, disabled]) {
      const res = await withToken(app, token, { method: 'GET', url: '/api/assets' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_token');
    }
    const reasons = (await auditActions('token.failed')).map((r) => r.details.reason);
    expect(reasons).toEqual(expect.arrayContaining(['expired', 'revoked', 'account_disabled']));
    expect((await auditActions('token.revoked')).length).toBeGreaterThan(0);

    const issue = await admin.request({
      method: 'POST',
      url: `/api/service-accounts/${disabled.accountId}/tokens`,
      payload: { scopes: ['assets:read'] },
    });
    expect(issue.statusCode).toBe(409);
  });

  it('refuses a token in the address or the body, and audits it', async () => {
    const admin = await signIn(app, 'root@example.com');
    const { token } = await issueToken(admin, ['assets:read', 'assets:write']);
    const inQuery = await app.inject({ method: 'GET', url: `/api/assets?access_token=${token}` });
    expect(inQuery.statusCode).toBe(400);
    expect(inQuery.json().error).toBe('token_in_url');

    const inBody = await withToken(app, token, {
      method: 'POST',
      url: '/api/asset-types',
      payload: { name: token, prefix: 'BOD' },
    });
    expect(inBody.statusCode).toBe(400);
    expect(inBody.json().error).toBe('token_in_body');

    const reasons = (await auditActions('token.failed')).map((r) => r.details.reason);
    expect(reasons).toEqual(expect.arrayContaining(['token_in_query', 'token_in_body']));
  });

  it('refuses a request that sends both a session cookie and a token', async () => {
    const admin = await signIn(app, 'root@example.com');
    const { token } = await issueToken(admin, ['assets:read']);
    const res = await app.inject({
      method: 'GET',
      url: '/api/assets',
      cookies: { [SESSION_COOKIE]: admin.cookie },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mixed_credentials');
  });

  it('limits requests per token and invalid attempts per address', async () => {
    await app.close();
    app = await makeApp({
      db: t.db,
      tokenLimits: { perTokenPerMinute: 3, invalidPerIp: 2, invalidWindowMs: 60_000 },
    });
    const admin = await signIn(app, 'root@example.com');
    const { token } = await issueToken(admin, ['assets:read']);
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (await withToken(app, token, { method: 'GET', url: '/api/assets' })).statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429]);

    const bad = `oitsm_${'0'.repeat(16)}_${'0'.repeat(64)}`;
    const badStatuses = [];
    for (let i = 0; i < 4; i += 1) {
      badStatuses.push(
        (await withToken(app, bad, { method: 'GET', url: '/api/assets' })).statusCode,
      );
    }
    expect(badStatuses).toEqual([401, 401, 429, 429]);
    // Blocked attempts are not audited, so a flood cannot fill the log.
    const unknown = (await auditActions('token.failed')).filter(
      (r) => r.details.reason === 'unknown',
    );
    expect(unknown).toHaveLength(2);
  });

  it('never writes a token value to the log', async () => {
    await app.close();
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    app = await makeApp({ db: t.db, logger: { ...loggerOptions('trace'), stream } });
    const admin = await signIn(app, 'root@example.com');
    const { token } = await issueToken(admin, ['assets:read']);
    await withToken(app, token, { method: 'GET', url: '/api/assets' });
    await app.inject({ method: 'GET', url: `/api/assets?token=${token}` });
    await withToken(app, `${token}x`, { method: 'GET', url: '/api/assets' });
    const log = lines.join('');
    expect(log).toContain('/api/assets');
    expect(log).not.toContain(token.split('_')[2]);
  });

  it('deletes an unused service account but not one with history', async () => {
    const admin = await signIn(app, 'root@example.com');
    const unused = await admin.request({
      method: 'POST',
      url: '/api/service-accounts',
      payload: { name: 'Unused' },
    });
    expect(
      (await admin.request({ method: 'DELETE', url: `/api/service-accounts/${unused.json().id}` }))
        .statusCode,
    ).toBe(204);

    const { token, accountId } = await issueToken(admin, ['assets:write']);
    await withToken(app, token, {
      method: 'POST',
      url: '/api/asset-types',
      payload: { name: 'History type', prefix: 'HIS' },
    });
    const res = await admin.request({
      method: 'DELETE',
      url: `/api/service-accounts/${accountId}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('has_history');
  });
});
