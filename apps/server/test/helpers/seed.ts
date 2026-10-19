import { hashPassword } from '../../src/auth/password.js';
import type { Db } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { SESSION_COOKIE } from '../../src/auth/http.js';
import type { makeApp } from './app.js';

type App = Awaited<ReturnType<typeof makeApp>>;

export const PASSWORD = 'a perfectly long password';

export async function createUser(db: Db, email: string, role: 'admin' | 'technician') {
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: email.split('@')[0] ?? email,
      role,
      passwordHash: await hashPassword(PASSWORD),
    })
    .returning();
  if (!row) throw new Error('no row');
  return row;
}

/** Signs in and returns a helper that sends authenticated requests with the CSRF header. */
export async function signIn(app: App, email: string, password = PASSWORD) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  const csrfToken: string = res.json().csrfToken;
  return {
    cookie,
    csrfToken,
    request: (opts: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: string;
      payload?: object | string;
      headers?: Record<string, string>;
    }) =>
      app.inject({
        ...opts,
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { ...opts.headers, 'x-csrf-token': csrfToken },
      }),
  };
}

type Session = Awaited<ReturnType<typeof signIn>>;

/** Creates a service account through the admin API and issues it a token. */
export async function issueToken(
  admin: Session,
  scopes: string[],
  name = `svc-${Math.random().toString(36).slice(2, 8)}`,
) {
  const account = await admin.request({
    method: 'POST',
    url: '/api/service-accounts',
    payload: { name },
  });
  if (account.statusCode !== 201) throw new Error(`account: ${account.statusCode} ${account.body}`);
  const accountId: string = account.json().id;
  const res = await admin.request({
    method: 'POST',
    url: `/api/service-accounts/${accountId}/tokens`,
    payload: { scopes },
  });
  if (res.statusCode !== 201) throw new Error(`token: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { accountId, tokenId: body.apiToken.id as string, token: body.token as string };
}

/** Sends a request with a bearer token. */
export function withToken(
  app: App,
  token: string,
  opts: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: object | string;
    headers?: Record<string, string>;
  },
) {
  return app.inject({ ...opts, headers: { ...opts.headers, authorization: `Bearer ${token}` } });
}
