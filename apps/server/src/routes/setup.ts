import {
  errorResponseSchema,
  sessionResponseSchema,
  setupRequestSchema,
  setupStatusSchema,
} from '@open-itsm/shared';
import { count, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audit } from '../audit.js';
import { setSessionCookie } from '../auth/http.js';
import { hashPassword } from '../auth/password.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { AUTH_RATE_LIMIT, USERS_LOCK_KEY, type RouteDeps } from './deps.js';

export async function hasUsers(db: Pick<Db, 'select'>): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(users);
  return (row?.n ?? 0) > 0;
}

export function registerSetupRoutes(app: FastifyInstance, { db, sessions, setupToken }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/setup/status',
    {
      schema: {
        summary: 'Whether the first-run setup wizard is still needed',
        tags: ['setup'],
        response: { 200: setupStatusSchema },
      },
    },
    async () => ({ required: !(await hasUsers(db)) }),
  );

  r.post(
    '/api/setup',
    {
      config: { csrf: 'origin-only', rateLimit: AUTH_RATE_LIMIT },
      schema: {
        summary: 'Create the first administrator (works only while no users exist)',
        tags: ['setup'],
        body: setupRequestSchema,
        response: {
          201: sessionResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { token, name, email, password } = request.body;
      const passwordHash = await hashPassword(password);

      // The advisory lock makes "no users yet" and the insert atomic across concurrent requests.
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${USERS_LOCK_KEY})`);
        if (await hasUsers(tx)) return 'complete' as const;
        if (!setupToken.matches(token)) return 'bad_token' as const;
        const [user] = await tx
          .insert(users)
          .values({ email, name, role: 'admin', passwordHash })
          .returning({ id: users.id, email: users.email, name: users.name, role: users.role });
        if (!user) throw new Error('insert returned no row');
        await audit(tx, {
          action: 'setup.completed',
          actorUserId: user.id,
          targetUserId: user.id,
          ip: request.ip,
        });
        return user;
      });

      if (outcome === 'complete') {
        return reply
          .code(409)
          .send({ error: 'setup_complete', message: 'Setup has already been completed' });
      }
      if (outcome === 'bad_token') {
        return reply
          .code(403)
          .send({ error: 'bad_token', message: 'The setup token is not valid' });
      }

      setupToken.clear();
      request.log.info({ userId: outcome.id }, 'first administrator created; setup token cleared');
      const session = await sessions.create(outcome.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookie(reply, session.token, session.expiresAt);
      return reply.code(201).send({ user: outcome, csrfToken: session.csrfToken });
    },
  );
}
