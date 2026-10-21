import {
  adjustConsumableRequestSchema,
  CONSUMABLE_HISTORY_LIMIT,
  consumableDetailSchema,
  consumableListQuerySchema,
  consumableListResponseSchema,
  createConsumableRequestSchema,
  errorResponseSchema,
  isLowStock,
  lowStockSummarySchema,
  openRepairListSchema,
  updateConsumableRequestSchema,
  type Consumable,
  type ConsumableDetail,
  type ConsumableListResponse,
} from '@open-itsm/shared';
import { and, asc, count, desc, eq, ilike, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf } from '../auth/http.js';
import type { Db } from '../db/client.js';
import {
  assets,
  consumableAdjustments,
  consumables,
  repairs,
  serviceAccounts,
  users,
} from '../db/schema.js';
import { actorName } from './asset-history.js';
import { likePattern } from './assets.js';
import { ASSETS_READ, ASSETS_WRITE, isUniqueViolation, type RouteDeps } from './deps.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Pick<Db, 'select'>;

const idParams = z.object({ id: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That consumable no longer exists. Reload the page.',
} as const;

const NAME_TAKEN = {
  error: 'name_taken',
  message: 'A consumable with that name already exists. Change its stock instead.',
} as const;

/** Low means at or below a threshold above zero; matches `isLowStock`. */
const lowCondition = sql`${consumables.lowStockThreshold} > 0 and ${consumables.quantity} <= ${consumables.lowStockThreshold}`;

function toConsumable(row: typeof consumables.$inferSelect): Consumable {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    lowStockThreshold: row.lowStockThreshold,
    low: isLowStock(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadDetail(db: Executor, id: string): Promise<ConsumableDetail | undefined> {
  const [row] = await db.select().from(consumables).where(eq(consumables.id, id));
  if (!row) return undefined;
  const [adjustments, [changes]] = await Promise.all([
    db
      .select({
        row: consumableAdjustments,
        userName: users.name,
        saName: serviceAccounts.name,
        repairSummary: repairs.summary,
        assetId: assets.id,
        assetNumber: assets.number,
        assetName: assets.name,
      })
      .from(consumableAdjustments)
      .leftJoin(users, eq(users.id, consumableAdjustments.actorUserId))
      .leftJoin(
        serviceAccounts,
        eq(serviceAccounts.id, consumableAdjustments.actorServiceAccountId),
      )
      .leftJoin(repairs, eq(repairs.id, consumableAdjustments.repairId))
      .leftJoin(assets, eq(assets.id, repairs.assetId))
      .where(eq(consumableAdjustments.consumableId, id))
      .orderBy(desc(consumableAdjustments.at), desc(consumableAdjustments.id))
      .limit(CONSUMABLE_HISTORY_LIMIT),
    db
      .select({ n: count() })
      .from(consumableAdjustments)
      .where(
        and(eq(consumableAdjustments.consumableId, id), ne(consumableAdjustments.kind, 'created')),
      ),
  ]);
  return {
    ...toConsumable(row),
    deletable: (changes?.n ?? 0) === 0,
    adjustments: adjustments.map((a) => ({
      id: a.row.id,
      kind: a.row.kind,
      change: a.row.change,
      quantityAfter: a.row.quantityAfter,
      reason: a.row.reason,
      at: a.row.at.toISOString(),
      by: actorName(a.userName, a.saName),
      repair:
        a.row.repairId && a.repairSummary !== null && a.assetId && a.assetNumber && a.assetName
          ? {
              id: a.row.repairId,
              summary: a.repairSummary,
              asset: { id: a.assetId, number: a.assetNumber, name: a.assetName },
            }
          : null,
    })),
  };
}

/** After a write in a committed transaction, the row is there unless deleted the same moment. */
async function loadWritten(db: Executor, id: string): Promise<ConsumableDetail> {
  const detail = await loadDetail(db, id);
  if (!detail) throw new Error(`consumable ${id} vanished after a write`);
  return detail;
}

export function registerConsumableRoutes(app: FastifyInstance, { db }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/consumables',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'Search consumables, a page at a time, with the number that are low on stock',
        tags: ['consumables'],
        querystring: consumableListQuerySchema,
        response: { 200: consumableListResponseSchema },
      },
    },
    async (request): Promise<ConsumableListResponse> => {
      const { q, low, page, pageSize } = request.query;
      const filters: SQL[] = [];
      if (q) filters.push(ilike(consumables.name, likePattern(q)));
      const base = and(...filters);
      const where = low ? and(base, lowCondition) : base;
      const [rows, [allCount], [lowCount]] = await Promise.all([
        db
          .select()
          .from(consumables)
          .where(where)
          .orderBy(asc(sql`lower(${consumables.name})`))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db.select({ n: count() }).from(consumables).where(base),
        db.select({ n: count() }).from(consumables).where(and(base, lowCondition)),
      ]);
      const all = allCount?.n ?? 0;
      const lowTotal = lowCount?.n ?? 0;
      return {
        items: rows.map(toConsumable),
        total: low ? lowTotal : all,
        page,
        pageSize,
        allCount: all,
        lowCount: lowTotal,
      };
    },
  );

  r.get(
    '/api/consumables/low-stock',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'Every consumable at or below its low-stock threshold, lowest stock first',
        tags: ['consumables'],
        response: { 200: lowStockSummarySchema },
      },
    },
    async () => {
      const rows = await db
        .select({ id: consumables.id, name: consumables.name, quantity: consumables.quantity })
        .from(consumables)
        .where(lowCondition)
        .orderBy(asc(consumables.quantity), asc(sql`lower(${consumables.name})`));
      return { count: rows.length, items: rows };
    },
  );

  r.get(
    '/api/consumables/:id',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'One consumable with its stock history, newest first',
        tags: ['consumables'],
        params: idParams,
        response: { 200: consumableDetailSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const detail = await loadDetail(db, request.params.id);
      return detail ?? reply.code(404).send(NOT_FOUND);
    },
  );

  r.post(
    '/api/consumables',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Add a consumable with its starting stock and low-stock threshold',
        tags: ['consumables'],
        body: createConsumableRequestSchema,
        response: { 201: consumableDetailSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { name, quantity, lowStockThreshold } = request.body;
      try {
        const id = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(consumables)
            .values({ name, lowStockThreshold })
            .returning({ id: consumables.id });
          if (!row) throw new Error('insert returned nothing');
          // The adjustment trigger sets the quantity.
          await tx.insert(consumableAdjustments).values({
            consumableId: row.id,
            kind: 'created',
            change: quantity,
            quantityAfter: quantity,
            ...actorOf(request),
          });
          return row.id;
        });
        return reply.code(201).send(await loadWritten(db, id));
      } catch (err) {
        if (isUniqueViolation(err, 'consumables_name_key')) {
          return reply.code(409).send(NAME_TAKEN);
        }
        throw err;
      }
    },
  );

  r.patch(
    '/api/consumables/:id',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Rename a consumable or change its low-stock threshold',
        description: 'The quantity changes only through adjustments, so its history stays whole.',
        tags: ['consumables'],
        params: idParams,
        body: updateConsumableRequestSchema,
        response: {
          200: consumableDetailSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const [row] = await db
          .update(consumables)
          .set({ ...request.body, updatedAt: new Date() })
          .where(eq(consumables.id, request.params.id))
          .returning({ id: consumables.id });
        if (!row) return reply.code(404).send(NOT_FOUND);
      } catch (err) {
        if (isUniqueViolation(err, 'consumables_name_key')) {
          return reply.code(409).send(NAME_TAKEN);
        }
        throw err;
      }
      return loadWritten(db, request.params.id);
    },
  );

  r.post(
    '/api/consumables/:id/adjustments',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Add stock, use stock (optionally for an open repair) or record a count',
        description:
          'Stock never goes below zero: a use larger than the stock on hand is refused with 409. A count sets the quantity and records the difference.',
        tags: ['consumables'],
        params: idParams,
        body: adjustConsumableRequestSchema,
        response: {
          200: consumableDetailSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const outcome = await db.transaction(async (tx: Tx) => {
        // Lock the row so two uses at once cannot both pass the stock check.
        const [current] = await tx
          .select({ quantity: consumables.quantity })
          .from(consumables)
          .where(eq(consumables.id, id))
          .for('update');
        if (!current) return NOT_FOUND;

        let change: number;
        let repairId: string | null = null;
        if (body.kind === 'add') {
          change = body.amount;
        } else if (body.kind === 'use') {
          if (body.amount > current.quantity) {
            return {
              error: 'not_enough_stock',
              message:
                current.quantity === 0
                  ? 'None left in stock. Add stock first, or record a count if some were found.'
                  : `Only ${current.quantity} left in stock. Use ${current.quantity} or fewer, or add stock first.`,
            };
          }
          change = -body.amount;
          if (body.repairId) {
            const [repair] = await tx
              .select({ id: repairs.id })
              .from(repairs)
              .where(and(eq(repairs.id, body.repairId), isNull(repairs.closedAt)));
            if (!repair) {
              return {
                error: 'repair_not_open',
                message: 'That repair is closed or no longer exists. Choose an open repair.',
              };
            }
            repairId = repair.id;
          }
        } else {
          change = body.quantity - current.quantity;
        }

        await tx.insert(consumableAdjustments).values({
          consumableId: id,
          kind: body.kind === 'add' ? 'added' : body.kind === 'use' ? 'used' : 'counted',
          change,
          quantityAfter: current.quantity + change,
          reason: body.reason,
          repairId,
          ...actorOf(request),
        });
        return undefined;
      });
      if (outcome === NOT_FOUND) return reply.code(404).send(NOT_FOUND);
      if (outcome) return reply.code(409).send(outcome);
      return loadWritten(db, id);
    },
  );

  r.delete(
    '/api/consumables/:id',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Delete a consumable entered by mistake',
        description: 'Allowed only while its stock has not changed since it was added.',
        tags: ['consumables'],
        params: idParams,
        response: { 204: z.null(), 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const deleted = await db.transaction(async (tx) => {
        await tx
          .select({ id: consumables.id })
          .from(consumables)
          .where(eq(consumables.id, id))
          .for('update');
        const [history] = await tx
          .select({ n: count() })
          .from(consumableAdjustments)
          .where(
            and(
              eq(consumableAdjustments.consumableId, id),
              ne(consumableAdjustments.kind, 'created'),
            ),
          );
        if (history && history.n > 0) return 'has_history' as const;
        const [row] = await tx
          .delete(consumables)
          .where(eq(consumables.id, id))
          .returning({ name: consumables.name, quantity: consumables.quantity });
        if (!row) return false;
        await audit(tx, {
          action: 'consumable.deleted',
          ...actorOf(request),
          ip: request.ip,
          details: { consumableId: id, name: row.name, quantity: row.quantity },
        });
        return true;
      });
      if (deleted === 'has_history') {
        return reply.code(409).send({
          error: 'has_history',
          message:
            'This consumable has stock history, so it cannot be deleted. Record a count of 0 instead.',
        });
      }
      if (!deleted) return reply.code(404).send(NOT_FOUND);
      return reply.code(204).send(null);
    },
  );

  r.get(
    '/api/repairs/open',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'Open repairs, for linking the consumables used on them',
        description: '`q` matches the asset number, the asset name or the repair summary.',
        tags: ['consumables'],
        querystring: z.object({ q: z.string().trim().max(200).optional() }),
        response: { 200: openRepairListSchema },
      },
    },
    async (request) => {
      const { q } = request.query;
      const pattern = q ? likePattern(q) : undefined;
      const rows = await db
        .select({
          id: repairs.id,
          summary: repairs.summary,
          assetId: assets.id,
          number: assets.number,
          name: assets.name,
        })
        .from(repairs)
        .innerJoin(assets, eq(assets.id, repairs.assetId))
        .where(
          and(
            isNull(repairs.closedAt),
            pattern
              ? or(
                  ilike(assets.number, pattern),
                  ilike(assets.name, pattern),
                  ilike(repairs.summary, pattern),
                )
              : undefined,
          ),
        )
        .orderBy(asc(sql`lower(${assets.number})`))
        .limit(100);
      return rows.map((row) => ({
        id: row.id,
        summary: row.summary,
        asset: { id: row.assetId, number: row.number, name: row.name },
      }));
    },
  );
}
