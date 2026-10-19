import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';
import { createUser, PASSWORD, signIn } from './helpers/seed.js';

describe.skipIf(!testDatabaseUrl)('roles and user administration', () => {
  let t: TestDatabase;
  let app: Awaited<ReturnType<typeof makeApp>>;
  let adminId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    adminId = (await createUser(t.db, 'root@example.com', 'admin')).id;
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

  it('requires a session for user administration', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401);
  });

  it('forbids technicians from user administration', async () => {
    const tech = await signIn(app, 'tech@example.com');
    expect((await tech.request({ method: 'GET', url: '/api/users' })).statusCode).toBe(403);
    const create = await tech.request({
      method: 'POST',
      url: '/api/users',
      payload: { name: 'X', email: 'x@example.com', role: 'admin', password: PASSWORD },
    });
    expect(create.statusCode).toBe(403);
  });

  it('lets an admin create a technician who can then sign in', async () => {
    const admin = await signIn(app, 'root@example.com');
    const res = await admin.request({
      method: 'POST',
      url: '/api/users',
      payload: {
        name: 'New Tech',
        email: 'New.Tech@Example.com',
        role: 'technician',
        password: PASSWORD,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      email: 'new.tech@example.com',
      role: 'technician',
      disabled: false,
    });
    expect(res.json()).not.toHaveProperty('passwordHash');
    await signIn(app, 'new.tech@example.com');
  });

  it('rejects a duplicate email regardless of case', async () => {
    const admin = await signIn(app, 'root@example.com');
    const res = await admin.request({
      method: 'POST',
      url: '/api/users',
      payload: { name: 'Dup', email: 'TECH@example.com', role: 'technician', password: PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('email_taken');
  });

  it('rejects a short password with a readable message', async () => {
    const admin = await signIn(app, 'root@example.com');
    const res = await admin.request({
      method: 'POST',
      url: '/api/users',
      payload: { name: 'Short', email: 'short@example.com', role: 'technician', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('at least 12 characters');
  });

  it('does not allow creating local end-user accounts', async () => {
    const admin = await signIn(app, 'root@example.com');
    const res = await admin.request({
      method: 'POST',
      url: '/api/users',
      payload: { name: 'EU', email: 'eu@example.com', role: 'end_user', password: PASSWORD },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps at least one active admin', async () => {
    const admin = await signIn(app, 'root@example.com');
    const demote = await admin.request({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      payload: { role: 'technician' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error).toBe('last_admin');
    const disable = await admin.request({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(409);
  });

  it('signs a user out everywhere when disabled, and lets them back in when re-enabled', async () => {
    const victim = await createUser(t.db, 'disable-me@example.com', 'technician');
    const theirs = await signIn(app, 'disable-me@example.com');
    const admin = await signIn(app, 'root@example.com');

    let res = await admin.request({
      method: 'PATCH',
      url: `/api/users/${victim.id}`,
      payload: { disabled: true },
    });
    expect(res.json().disabled).toBe(true);
    expect((await theirs.request({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(
      401,
    );

    res = await admin.request({
      method: 'PATCH',
      url: `/api/users/${victim.id}`,
      payload: { disabled: false },
    });
    expect(res.json().disabled).toBe(false);
    await signIn(app, 'disable-me@example.com');
  });

  it('applies a role change on the next request', async () => {
    const promoted = await createUser(t.db, 'promote@example.com', 'technician');
    const theirs = await signIn(app, 'promote@example.com');
    const admin = await signIn(app, 'root@example.com');
    await admin.request({
      method: 'PATCH',
      url: `/api/users/${promoted.id}`,
      payload: { role: 'admin' },
    });
    expect((await theirs.request({ method: 'GET', url: '/api/users' })).statusCode).toBe(200);
  });

  it('resets a password and signs the user out, keeping the admin’s own session', async () => {
    const target = await createUser(t.db, 'reset-me@example.com', 'technician');
    const theirs = await signIn(app, 'reset-me@example.com');
    const admin = await signIn(app, 'root@example.com');
    const res = await admin.request({
      method: 'POST',
      url: `/api/users/${target.id}/password`,
      payload: { password: 'a brand new password' },
    });
    expect(res.statusCode).toBe(204);
    expect((await theirs.request({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(
      401,
    );
    expect((await admin.request({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(200);
    await signIn(app, 'reset-me@example.com', 'a brand new password');

    // Resetting your own password keeps the session you used to do it.
    const self = await admin.request({
      method: 'POST',
      url: `/api/users/${adminId}/password`,
      payload: { password: PASSWORD },
    });
    expect(self.statusCode).toBe(204);
    expect((await admin.request({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(200);
  });

  it('returns 404 for an unknown user and 400 for a malformed id', async () => {
    const admin = await signIn(app, 'root@example.com');
    const missing = await admin.request({
      method: 'PATCH',
      url: '/api/users/00000000-0000-4000-8000-000000000000',
      payload: { name: 'Nobody' },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await admin.request({
      method: 'PATCH',
      url: '/api/users/123',
      payload: { name: 'x' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
