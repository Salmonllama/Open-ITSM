import {
  adminUserSchema,
  createUserRequestSchema,
  errorResponseSchema,
  setPasswordRequestSchema,
  updateUserRequestSchema,
  type AdminUser,
} from '@open-itsm/shared';
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireRole } from '../auth/http.js';
import { hashPassword } from '../auth/password.js';
import { users } from '../db/schema.js';
import { USERS_LOCK_KEY, type RouteDeps } from './deps.js';

const idParams = z.object({ id: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That user no longer exists. Reload the page.',
} as const;
const LAST_ADMIN = {
  error: 'last_admin',
  message:
    'Open ITSM needs at least one active administrator. Make someone else an administrator first.',
} as const;

function toAdminUser(row: typeof users.$inferSelect): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: row.disabledAt !== null,
    hasPassword: row.passwordHash !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } }).code;
  const causeCode = (err as { cause?: { code?: string } }).cause?.code;
  return code === '23505' || causeCode === '23505';
}

export function registerUserRoutes(app: FastifyInstance, { db, sessions }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const adminOnly = requireRole('admin');

  r.get(
    '/api/users',
    {
      preHandler: adminOnly,
      schema: {
        summary: 'List all user accounts',
        tags: ['users'],
        response: { 200: z.array(adminUserSchema) },
      },
    },
    async () => (await db.select().from(users).orderBy(asc(users.name))).map(toAdminUser),
  );

  r.post(
    '/api/users',
    {
      preHandler: adminOnly,
      schema: {
        summary: 'Create a local administrator or technician account',
        tags: ['users'],
        body: createUserRequestSchema,
        response: { 201: adminUserSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { name, email, role, password } = request.body;
      const passwordHash = await hashPassword(password);
      try {
        const created = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(users)
            .values({ name, email, role, passwordHash })
            .returning();
          if (!row) throw new Error('insert returned no row');
          await audit(tx, {
            action: 'user.created',
            actorUserId: request.session?.user.id,
            targetUserId: row.id,
            ip: request.ip,
            details: { role },
          });
          return row;
        });
        return reply.code(201).send(toAdminUser(created));
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: 'email_taken',
            message:
              'A user with that email already exists. Use a different email or edit the existing user.',
          });
        }
        throw err;
      }
    },
  );

  r.patch(
    '/api/users/:id',
    {
      preHandler: adminOnly,
      schema: {
        summary: 'Change a user’s name, role or disabled state',
        tags: ['users'],
        params: idParams,
        body: updateUserRequestSchema,
        response: { 200: adminUserSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { name, role, disabled } = request.body;

      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${USERS_LOCK_KEY})`);
        const [current] = await tx.select().from(users).where(eq(users.id, id));
        if (!current) return 'not_found' as const;

        const isActiveAdmin = current.role === 'admin' && current.disabledAt === null;
        const losesAdmin = (role !== undefined && role !== 'admin') || disabled === true;
        if (isActiveAdmin && losesAdmin) {
          const [others] = await tx
            .select({ n: count() })
            .from(users)
            .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, id)));
          if ((others?.n ?? 0) === 0) return 'last_admin' as const;
        }

        const changes: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
        if (name !== undefined) changes.name = name;
        if (role !== undefined) changes.role = role;
        if (disabled !== undefined)
          changes.disabledAt = disabled ? (current.disabledAt ?? new Date()) : null;

        const [updated] = await tx.update(users).set(changes).where(eq(users.id, id)).returning();
        if (!updated) throw new Error('update returned no row');
        if (disabled === true) await sessions.revokeAllForUser(id, tx);
        await audit(tx, {
          action: 'user.updated',
          actorUserId: request.session?.user.id,
          targetUserId: id,
          ip: request.ip,
          details: { name: name !== undefined, role, disabled },
        });
        return updated;
      });

      if (result === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (result === 'last_admin') return reply.code(409).send(LAST_ADMIN);
      return toAdminUser(result);
    },
  );

  r.post(
    '/api/users/:id/password',
    {
      preHandler: adminOnly,
      schema: {
        summary: 'Set a new password; signs the user out everywhere and clears any lockout',
        tags: ['users'],
        params: idParams,
        body: setPasswordRequestSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const passwordHash = await hashPassword(request.body.password);
      const found = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
          .where(eq(users.id, id))
          .returning({ id: users.id });
        if (!row) return false;
        await sessions.revokeAllForUser(id, tx, request.session?.id);
        await audit(tx, {
          action: 'user.password_reset',
          actorUserId: request.session?.user.id,
          targetUserId: id,
          ip: request.ip,
          details: { via: 'admin' },
        });
        return true;
      });
      if (!found) return reply.code(404).send(NOT_FOUND);
      return reply.code(204).send();
    },
  );
}
