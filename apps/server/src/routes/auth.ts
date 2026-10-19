import { errorResponseSchema, loginRequestSchema, sessionResponseSchema } from '@open-itsm/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit } from '../audit.js';
import { clearSessionCookie, setSessionCookie } from '../auth/http.js';
import { dummyHash, verifyPassword } from '../auth/password.js';
import { users } from '../db/schema.js';
import { AUTH_RATE_LIMIT, type RouteDeps } from './deps.js';

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

const INVALID = { error: 'invalid_credentials', message: 'Invalid email or password' } as const;
const LOCKED = {
  error: 'locked',
  message: 'Too many failed sign-in attempts. Try again in a few minutes.',
} as const;

export function registerAuthRoutes(app: FastifyInstance, { db, sessions }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/api/auth/login',
    {
      config: { csrf: 'origin-only', rateLimit: AUTH_RATE_LIMIT },
      schema: {
        summary: 'Sign in with a local account',
        tags: ['auth'],
        body: loginRequestSchema,
        response: {
          200: sessionResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const ip = request.ip;
      const [user] = await db.select().from(users).where(eq(users.email, email));

      if (!user || !user.passwordHash || user.disabledAt) {
        // Same work as a real check, so response time does not reveal which emails exist.
        await verifyPassword(dummyHash, password);
        await audit(db, {
          action: 'login.failed',
          targetUserId: user?.id ?? null,
          ip,
          details: {
            email,
            reason: !user ? 'unknown_email' : user.disabledAt ? 'disabled' : 'no_password',
          },
        });
        return reply.code(401).send(INVALID);
      }

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        await audit(db, { action: 'login.locked', targetUserId: user.id, ip, details: { email } });
        return reply.code(429).send(LOCKED);
      }

      if (!(await verifyPassword(user.passwordHash, password))) {
        // Counted in SQL so concurrent failures cannot undercount; the counter resets on lock.
        const [updated] = await db
          .update(users)
          .set({
            failedLoginCount: sql`case when ${users.failedLoginCount} + 1 >= ${LOCKOUT_THRESHOLD} then 0 else ${users.failedLoginCount} + 1 end`,
            lockedUntil: sql`case when ${users.failedLoginCount} + 1 >= ${LOCKOUT_THRESHOLD} then now() + make_interval(secs => ${LOCKOUT_MS / 1000}) else ${users.lockedUntil} end`,
          })
          .where(eq(users.id, user.id))
          .returning({ lockedUntil: users.lockedUntil });
        const lockedNow = !!updated?.lockedUntil && updated.lockedUntil > new Date();
        await audit(db, {
          action: 'login.failed',
          targetUserId: user.id,
          ip,
          details: { email, reason: 'bad_password', locked: lockedNow },
        });
        return reply.code(401).send(INVALID);
      }

      await db
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      const session = await sessions.create(user.id, {
        ip,
        userAgent: request.headers['user-agent'],
      });
      await audit(db, { action: 'login.succeeded', actorUserId: user.id, ip });
      setSessionCookie(reply, session.token, session.expiresAt);
      return {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        csrfToken: session.csrfToken,
      };
    },
  );

  r.post(
    '/api/auth/logout',
    { schema: { summary: 'Sign out and revoke the current session', tags: ['auth'] } },
    async (request, reply) => {
      if (request.session) {
        await sessions.revoke(request.session.id);
        await audit(db, { action: 'logout', actorUserId: request.session.user.id, ip: request.ip });
      }
      clearSessionCookie(reply);
      return reply.code(204).send();
    },
  );

  r.get(
    '/api/auth/session',
    {
      schema: {
        summary: 'The signed-in user and the CSRF token for write requests',
        tags: ['auth'],
        response: { 200: sessionResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.session) {
        return reply.code(401).send({ error: 'unauthenticated', message: 'Not signed in' });
      }
      return { user: request.session.user, csrfToken: request.session.csrfToken };
    },
  );
}
