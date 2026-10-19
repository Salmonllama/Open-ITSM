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
      payload?: object;
    }) =>
      app.inject({
        ...opts,
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { 'x-csrf-token': csrfToken },
      }),
  };
}
