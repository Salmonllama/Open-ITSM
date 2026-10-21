import {
  ASSET_STATUSES,
  assetListQuerySchema,
  assetListResponseSchema,
  assetNumberSchema,
  assetSchema,
  createAssetRequestSchema,
  errorResponseSchema,
  updateAssetRequestSchema,
  type Asset,
  type AssetListResponse,
  type AssetStatus,
} from '@open-itsm/shared';
import { and, asc, count, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { validateFieldValues, type FieldProblem } from '../assets/fields.js';
import { takeAssetNumbers } from '../assets/numbers.js';
import { audit } from '../audit.js';
import { actorOf } from '../auth/http.js';
import type { Db } from '../db/client.js';
import { assetEvents, assets, assetTypes, serviceAccounts, users } from '../db/schema.js';
import { loadFields } from './asset-types.js';
import { ASSETS_READ, ASSETS_WRITE, isUniqueViolation, type RouteDeps } from './deps.js';
import { registerAssetImportRoute } from './asset-import.js';
import {
  lockedStatusRefusal,
  recordAssetChange,
  registerAssetHistoryRoutes,
} from './asset-history.js';

const idParams = z.object({ id: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That asset no longer exists. Reload the page.',
} as const;
const TYPE_NOT_FOUND = {
  error: 'type_not_found',
  message: 'That asset type no longer exists. Reload the page and choose another.',
} as const;

export function numberTaken(number: string | undefined) {
  return {
    error: 'number_taken',
    message:
      number === undefined
        ? 'Another change took that asset number at the same moment. Try again.'
        : `Asset number ${number} is already used by another asset. Choose a different number, or leave it blank to use the next one.`,
  };
}

function fieldProblemsResponse(problems: FieldProblem[]) {
  return {
    error: 'validation',
    message: problems.map((p) => `${p.label} ${p.message}`).join('. '),
  };
}

/** Escapes LIKE wildcards so a search for `50%` matches the text, not a pattern. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Who made the change, for the updated_by columns. */
function updaterOf(request: FastifyRequest) {
  const { actorUserId, actorServiceAccountId } = actorOf(request);
  return { updatedByUserId: actorUserId, updatedByServiceAccountId: actorServiceAccountId };
}

/** For an asset just written in this request, which must exist. */
export async function loadWrittenAsset(db: Pick<Db, 'select'>, id: string): Promise<Asset> {
  const asset = await loadAsset(db, eq(assets.id, id));
  if (!asset) throw new Error(`asset ${id} not found after write`);
  return asset;
}

async function loadAsset(db: Pick<Db, 'select'>, where: SQL): Promise<Asset | undefined> {
  const [row] = await db
    .select({
      asset: assets,
      typeName: assetTypes.name,
      userName: users.name,
      serviceAccountName: serviceAccounts.name,
    })
    .from(assets)
    .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
    .leftJoin(users, eq(users.id, assets.updatedByUserId))
    .leftJoin(serviceAccounts, eq(serviceAccounts.id, assets.updatedByServiceAccountId))
    .where(where);
  if (!row) return undefined;
  const { asset } = row;
  return {
    id: asset.id,
    number: asset.number,
    name: asset.name,
    status: asset.status,
    type: { id: asset.assetTypeId, name: row.typeName },
    fields: asset.fields,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    updatedBy: row.userName
      ? { kind: 'user', name: row.userName }
      : row.serviceAccountName
        ? { kind: 'service_account', name: row.serviceAccountName }
        : null,
  };
}

export function registerAssetRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/assets',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'Search and filter assets, a page at a time, with counts per status',
        description:
          '`q` matches the number, name and custom field values. Counts ignore the status filter, so each status tab can show its total.',
        tags: ['assets'],
        querystring: assetListQuerySchema,
        response: { 200: assetListResponseSchema },
      },
    },
    async (request): Promise<AssetListResponse> => {
      const { q, status, typeId, page, pageSize } = request.query;
      const filters: SQL[] = [];
      if (typeId) filters.push(eq(assets.assetTypeId, typeId));
      if (q) {
        const pattern = likePattern(q);
        const match = or(
          ilike(assets.number, pattern),
          ilike(assets.name, pattern),
          ilike(sql`${assets.fields}::text`, pattern),
        );
        if (match) filters.push(match);
      }
      const base = and(...filters);
      const where = status ? and(base, eq(assets.status, status)) : base;

      const [rows, byStatus] = await Promise.all([
        db
          .select({
            id: assets.id,
            number: assets.number,
            name: assets.name,
            status: assets.status,
            typeId: assets.assetTypeId,
            typeName: assetTypes.name,
            updatedAt: assets.updatedAt,
          })
          .from(assets)
          .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
          .where(where)
          .orderBy(asc(sql`lower(${assets.number})`))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db
          .select({ status: assets.status, n: count() })
          .from(assets)
          .where(base)
          .groupBy(assets.status),
      ]);

      const counts = Object.fromEntries(ASSET_STATUSES.map((s) => [s, 0])) as Record<
        AssetStatus,
        number
      >;
      for (const c of byStatus) counts[c.status] = c.n;
      const all = byStatus.reduce((sum, c) => sum + c.n, 0);
      return {
        items: rows.map((row) => ({
          id: row.id,
          number: row.number,
          name: row.name,
          status: row.status,
          type: { id: row.typeId, name: row.typeName },
          updatedAt: row.updatedAt.toISOString(),
        })),
        total: status ? counts[status] : all,
        page,
        pageSize,
        counts: { all, ...counts },
      };
    },
  );

  r.get(
    '/api/assets/:id',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'One asset with its custom field values',
        tags: ['assets'],
        params: idParams,
        response: { 200: assetSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const asset = await loadAsset(db, eq(assets.id, request.params.id));
      return asset ?? reply.code(404).send(NOT_FOUND);
    },
  );

  r.get(
    '/api/assets/by-number/:number',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'Find an asset by its number, ignoring case',
        tags: ['assets'],
        params: z.object({ number: assetNumberSchema }),
        response: { 200: assetSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const asset = await loadAsset(
        db,
        sql`lower(${assets.number}) = lower(${request.params.number})`,
      );
      return (
        asset ??
        reply.code(404).send({
          error: 'not_found',
          message: `No asset has the number ${request.params.number}.`,
        })
      );
    },
  );

  r.post(
    '/api/assets',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Create an asset; leave out the number to take the next one for its type',
        tags: ['assets'],
        body: createAssetRequestSchema,
        response: {
          201: assetSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { typeId, number, name, status, fields } = request.body;
      const definitions = await loadFields(db, typeId);
      const checked = validateFieldValues(definitions, fields);
      if (checked.problems.length > 0) {
        return reply.code(400).send(fieldProblemsResponse(checked.problems));
      }
      try {
        const outcome = await db.transaction(async (tx) => {
          let assetNumber = number;
          if (assetNumber === undefined) {
            assetNumber = (await takeAssetNumbers(tx, typeId, 1))?.[0];
            if (assetNumber === undefined) return 'type_not_found' as const;
          } else {
            const [type] = await tx
              .select({ id: assetTypes.id })
              .from(assetTypes)
              .where(eq(assetTypes.id, typeId));
            if (!type) return 'type_not_found' as const;
          }
          const [row] = await tx
            .insert(assets)
            .values({
              number: assetNumber,
              assetTypeId: typeId,
              name,
              status,
              fields: checked.values,
              ...updaterOf(request),
            })
            .returning({ id: assets.id });
          if (!row) throw new Error('insert returned no row');
          return row.id;
        });
        if (outcome === 'type_not_found') return reply.code(404).send(TYPE_NOT_FOUND);
        return reply.code(201).send(await loadWrittenAsset(db, outcome));
      } catch (err) {
        if (isUniqueViolation(err, 'assets_number_key')) {
          return reply.code(409).send(numberTaken(number));
        }
        throw err;
      }
    },
  );

  r.patch(
    '/api/assets/:id',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Change an asset’s number, name, status or custom field values',
        description:
          '`fields` replaces every custom field value; leave a key out to clear it. `status` can be Preparing, In stock or Retired, and only while the asset is not deployed or in repair: assign, return and repair it to change those.',
        tags: ['assets'],
        params: idParams,
        body: updateAssetRequestSchema,
        response: {
          200: assetSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { number, name, status, fields } = request.body;
      try {
        const outcome = await db.transaction(async (tx) => {
          const [current] = await tx
            .select({
              typeId: assets.assetTypeId,
              status: assets.status,
              number: assets.number,
              name: assets.name,
              fields: assets.fields,
            })
            .from(assets)
            .where(eq(assets.id, id))
            .for('update');
          if (!current) return { kind: 'not_found' } as const;
          const statusChanges = status !== undefined && status !== current.status;
          if (statusChanges) {
            const refusal = lockedStatusRefusal(current.status);
            if (refusal) return { kind: 'refused', refusal } as const;
          }
          const changes: Partial<typeof assets.$inferInsert> = {
            updatedAt: new Date(),
            ...updaterOf(request),
          };
          // Labels of what changed, for the activity feed.
          const edited: string[] = [];
          if (number !== undefined && number !== current.number) {
            changes.number = number;
            edited.push('Asset number');
          }
          if (name !== undefined && name !== current.name) {
            changes.name = name;
            edited.push('Name');
          }
          if (fields !== undefined) {
            const definitions = await loadFields(tx, current.typeId);
            const checked = validateFieldValues(definitions, fields);
            if (checked.problems.length > 0) {
              return { kind: 'problems', problems: checked.problems } as const;
            }
            changes.fields = checked.values;
            for (const field of definitions) {
              if (current.fields[field.key] !== checked.values[field.key]) edited.push(field.label);
            }
          }
          await tx.update(assets).set(changes).where(eq(assets.id, id));
          if (edited.length > 0) {
            await recordAssetChange(tx, request, id, {
              kind: 'edited',
              subject: edited.join(', '),
            });
          }
          if (statusChanges) {
            await recordAssetChange(tx, request, id, {
              kind: 'status_changed',
              fromStatus: current.status,
              toStatus: status,
            });
          }
          return { kind: 'ok' } as const;
        });
        if (outcome.kind === 'not_found') return reply.code(404).send(NOT_FOUND);
        if (outcome.kind === 'refused') return reply.code(409).send(outcome.refusal);
        if (outcome.kind === 'problems') {
          return reply.code(400).send(fieldProblemsResponse(outcome.problems));
        }
        return await loadWrittenAsset(db, id);
      } catch (err) {
        if (isUniqueViolation(err, 'assets_number_key')) {
          return reply.code(409).send(numberTaken(number));
        }
        throw err;
      }
    },
  );

  r.delete(
    '/api/assets/:id',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Delete an asset entered by mistake',
        description:
          'Allowed only while the asset has no history beyond edits (no status changes, assignments or repairs); otherwise retire it instead.',
        tags: ['assets'],
        params: idParams,
        response: { 204: z.null(), 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const deleted = await db.transaction(async (tx) => {
        // Lock first, so no assignment or repair can be added between the check and the delete.
        await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, id)).for('update');
        const [history] = await tx
          .select({ n: count() })
          .from(assetEvents)
          .where(and(eq(assetEvents.assetId, id), ne(assetEvents.kind, 'edited')));
        if (history && history.n > 0) return 'has_history' as const;
        const [row] = await tx
          .delete(assets)
          .where(eq(assets.id, id))
          .returning({ number: assets.number, name: assets.name, typeId: assets.assetTypeId });
        if (!row) return false;
        await audit(tx, {
          action: 'asset.deleted',
          ...actorOf(request),
          ip: request.ip,
          details: { assetId: id, number: row.number, name: row.name, assetTypeId: row.typeId },
        });
        return true;
      });
      if (deleted === 'has_history') {
        return reply.code(409).send({
          error: 'has_history',
          message:
            'This asset has history, so it cannot be deleted. Change its status to Retired instead.',
        });
      }
      if (!deleted) return reply.code(404).send(NOT_FOUND);
      return reply.code(204).send(null);
    },
  );

  registerAssetImportRoute(app, deps);
  registerAssetHistoryRoutes(app, deps);
}
