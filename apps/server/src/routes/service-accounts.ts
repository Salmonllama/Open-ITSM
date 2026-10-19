import {
  createServiceAccountRequestSchema,
  createTokenRequestSchema,
  createdTokenSchema,
  errorResponseSchema,
  serviceAccountSchema,
  updateServiceAccountRequestSchema,
  type ApiToken,
  type ServiceAccount,
  type TokenScope,
} from '@open-itsm/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf } from '../auth/http.js';
import type { Db } from '../db/client.js';
import { apiTokens, serviceAccounts, users } from '../db/schema.js';
import { ADMIN_ONLY, isForeignKeyViolation, isUniqueViolation, type RouteDeps } from './deps.js';

const idParams = z.object({ id: z.uuid() });
const tokenParams = z.object({ id: z.uuid(), tokenId: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That service account no longer exists. Reload the page.',
} as const;
const NAME_TAKEN = {
  error: 'name_taken',
  message: 'A service account with that name already exists. Choose another name.',
} as const;

type AccountRow = typeof serviceAccounts.$inferSelect & { createdBy: string | null };
type TokenRow = typeof apiTokens.$inferSelect & { createdBy: string | null };

function toApiToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    publicId: row.publicId,
    scopes: row.scopes as TokenScope[],
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function toServiceAccount(row: AccountRow, tokens: TokenRow[]): ServiceAccount {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    disabled: row.disabledAt !== null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    tokens: tokens.map(toApiToken),
  };
}

async function loadAccounts(db: Db, ids?: string[]): Promise<ServiceAccount[]> {
  const accountCreator = alias(users, 'account_creator');
  const tokenCreator = alias(users, 'token_creator');
  const accounts = await db
    .select({ account: serviceAccounts, createdBy: accountCreator.name })
    .from(serviceAccounts)
    .leftJoin(accountCreator, eq(accountCreator.id, serviceAccounts.createdByUserId))
    .where(ids ? inArray(serviceAccounts.id, ids) : undefined)
    .orderBy(asc(serviceAccounts.name));
  if (accounts.length === 0) return [];
  const tokens = await db
    .select({ token: apiTokens, createdBy: tokenCreator.name })
    .from(apiTokens)
    .leftJoin(tokenCreator, eq(tokenCreator.id, apiTokens.createdByUserId))
    .where(
      inArray(
        apiTokens.serviceAccountId,
        accounts.map((a) => a.account.id),
      ),
    )
    .orderBy(desc(apiTokens.createdAt));
  return accounts.map(({ account, createdBy }) =>
    toServiceAccount(
      { ...account, createdBy },
      tokens
        .filter((t) => t.token.serviceAccountId === account.id)
        .map((t) => ({ ...t.token, createdBy: t.createdBy })),
    ),
  );
}

export function registerServiceAccountRoutes(app: FastifyInstance, { db, tokens }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function loadOne(id: string) {
    const [account] = await loadAccounts(db, [id]);
    return account;
  }

  /** For a row just written in this request, which must exist. */
  async function loadWritten(id: string) {
    const account = await loadOne(id);
    if (!account) throw new Error(`row ${id} not found after write`);
    return account;
  }

  r.get(
    '/api/service-accounts',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'List service accounts with their tokens (never the token values)',
        tags: ['service accounts'],
        response: { 200: z.array(serviceAccountSchema) },
      },
    },
    () => loadAccounts(db),
  );

  r.post(
    '/api/service-accounts',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Create a service account for a script or integration',
        tags: ['service accounts'],
        body: createServiceAccountRequestSchema,
        response: { 201: serviceAccountSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { name, description } = request.body;
      const userId = request.session?.user.id;
      if (!userId) throw new Error('admin route reached without a session');
      try {
        const id = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(serviceAccounts)
            .values({ name, description, createdByUserId: userId })
            .returning({ id: serviceAccounts.id });
          if (!row) throw new Error('insert returned no row');
          await audit(tx, {
            action: 'service_account.created',
            ...actorOf(request),
            ip: request.ip,
            details: { serviceAccountId: row.id, name },
          });
          return row.id;
        });
        return reply.code(201).send(await loadWritten(id));
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send(NAME_TAKEN);
        throw err;
      }
    },
  );

  r.patch(
    '/api/service-accounts/:id',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Rename, describe, disable or enable a service account',
        tags: ['service accounts'],
        params: idParams,
        body: updateServiceAccountRequestSchema,
        response: { 200: serviceAccountSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { name, description, disabled } = request.body;
      try {
        const found = await db.transaction(async (tx) => {
          const [current] = await tx
            .select({ disabledAt: serviceAccounts.disabledAt })
            .from(serviceAccounts)
            .where(eq(serviceAccounts.id, id))
            .for('update');
          if (!current) return false;
          const changes: Partial<typeof serviceAccounts.$inferInsert> = {};
          if (name !== undefined) changes.name = name;
          if (description !== undefined) changes.description = description;
          if (disabled !== undefined)
            changes.disabledAt = disabled ? (current.disabledAt ?? new Date()) : null;
          await tx.update(serviceAccounts).set(changes).where(eq(serviceAccounts.id, id));
          await audit(tx, {
            action: 'service_account.updated',
            ...actorOf(request),
            ip: request.ip,
            details: {
              serviceAccountId: id,
              name,
              description: description !== undefined,
              disabled,
            },
          });
          return true;
        });
        if (!found) return reply.code(404).send(NOT_FOUND);
        return await loadWritten(id);
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send(NAME_TAKEN);
        throw err;
      }
    },
  );

  r.delete(
    '/api/service-accounts/:id',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Delete a service account that has never changed anything; its tokens go with it',
        tags: ['service accounts'],
        params: idParams,
        response: { 204: z.null(), 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const deleted = await db.transaction(async (tx) => {
          const [row] = await tx
            .delete(serviceAccounts)
            .where(eq(serviceAccounts.id, id))
            .returning({ name: serviceAccounts.name });
          if (!row) return false;
          await audit(tx, {
            action: 'service_account.deleted',
            ...actorOf(request),
            ip: request.ip,
            details: { serviceAccountId: id, name: row.name },
          });
          return true;
        });
        if (!deleted) return reply.code(404).send(NOT_FOUND);
        return reply.code(204).send(null);
      } catch (err) {
        // Records it made (audit entries, asset changes) still name it, so it must stay.
        if (isForeignKeyViolation(err)) {
          return reply.code(409).send({
            error: 'has_history',
            message:
              'This service account has made changes, and the history needs its name. Disable it instead.',
          });
        }
        throw err;
      }
    },
  );

  r.post(
    '/api/service-accounts/:id/tokens',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Issue a token; the value is returned once and cannot be read again',
        tags: ['service accounts'],
        params: idParams,
        body: createTokenRequestSchema,
        response: { 201: createdTokenSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { scopes, expiresInDays } = request.body;
      const userId = request.session?.user.id;
      if (!userId) throw new Error('admin route reached without a session');

      const result = await db.transaction(async (tx) => {
        const [account] = await tx
          .select({ disabledAt: serviceAccounts.disabledAt })
          .from(serviceAccounts)
          .where(eq(serviceAccounts.id, id))
          .for('share');
        if (!account) return 'not_found' as const;
        if (account.disabledAt) return 'disabled' as const;
        const created = await tokens.create({
          serviceAccountId: id,
          scopes,
          expiresInDays,
          createdByUserId: userId,
          executor: tx,
        });
        await audit(tx, {
          action: 'token.created',
          ...actorOf(request),
          ip: request.ip,
          details: {
            serviceAccountId: id,
            tokenId: created.row.id,
            publicId: created.row.publicId,
            scopes,
            expiresAt: created.row.expiresAt.toISOString(),
          },
        });
        return created;
      });

      if (result === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (result === 'disabled') {
        return reply.code(409).send({
          error: 'account_disabled',
          message: 'This service account is disabled. Enable it before issuing a token.',
        });
      }
      return reply.code(201).send({
        token: result.token,
        apiToken: toApiToken({ ...result.row, createdBy: request.session?.user.name ?? null }),
      });
    },
  );

  r.post(
    '/api/service-accounts/:id/tokens/:tokenId/revoke',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Revoke a token; it stops working on the next request',
        tags: ['service accounts'],
        params: tokenParams,
        response: { 204: z.null(), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, tokenId } = request.params;
      const revoked = await db.transaction(async (tx) => {
        const [token] = await tx
          .select({
            id: apiTokens.id,
            publicId: apiTokens.publicId,
            revokedAt: apiTokens.revokedAt,
          })
          .from(apiTokens)
          .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.serviceAccountId, id)));
        if (!token) return false;
        if (token.revokedAt) return true;
        await tokens.revoke(tokenId, tx);
        await audit(tx, {
          action: 'token.revoked',
          ...actorOf(request),
          ip: request.ip,
          details: { serviceAccountId: id, tokenId, publicId: token.publicId },
        });
        return true;
      });
      if (!revoked) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'That token no longer exists. Reload the page.',
        });
      }
      return reply.code(204).send(null);
    },
  );
}
