import {
  assetHistorySchema,
  assetSchema,
  assetStatusLabels,
  assignAssetRequestSchema,
  assignmentSuggestionsSchema,
  closeRepairRequestSchema,
  errorResponseSchema,
  openRepairRequestSchema,
  returnAssetRequestSchema,
  type Actor,
  type AssetHistory,
  type AssetStatus,
} from '@open-itsm/shared';
import { aliasedTable, and, desc, eq, ilike, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf } from '../auth/http.js';
import type { Db } from '../db/client.js';
import {
  assetAssignments,
  assetEvents,
  assets,
  repairs,
  serviceAccounts,
  users,
} from '../db/schema.js';
import { ASSETS_READ, ASSETS_WRITE, isUniqueViolation, type RouteDeps } from './deps.js';
import { loadWrittenAsset } from './assets.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const idParams = z.object({ id: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That asset no longer exists. Reload the page.',
} as const;

/** A refusal the person can fix: 409 with what happened and what to do. */
type Refusal = { error: string; message: string };

function refuse(error: string, message: string): Refusal {
  return { error, message };
}

const RETIRED = refuse(
  'asset_retired',
  'This asset is retired. Change its status to In stock first if it is back in use.',
);
const IN_REPAIR = refuse(
  'asset_in_repair',
  'This asset is in repair. Close the repair first, then try again.',
);
const CHANGED = refuse(
  'conflict',
  'Someone else changed this asset at the same moment. Reload the page and try again.',
);

export function actorName(
  userName: string | null,
  serviceAccountName: string | null,
): Actor | null {
  if (userName) return { kind: 'user', name: userName };
  if (serviceAccountName) return { kind: 'service_account', name: serviceAccountName };
  return null;
}

/** Locks the asset row so status changes and history writes for one asset happen in turn. */
async function lockAsset(tx: Tx, id: string) {
  const [row] = await tx
    .select({ status: assets.status })
    .from(assets)
    .where(eq(assets.id, id))
    .for('update');
  return row;
}

type EventInput = {
  kind: (typeof assetEvents.$inferInsert)['kind'];
  fromStatus?: AssetStatus | null;
  toStatus?: AssetStatus | null;
  subject?: string;
};

/** Writes an activity row and, when the status moves, the asset's new status. */
export async function recordAssetChange(
  tx: Pick<Tx, 'insert' | 'update'>,
  request: FastifyRequest,
  assetId: string,
  event: EventInput,
) {
  const { actorUserId, actorServiceAccountId } = actorOf(request);
  await tx.insert(assetEvents).values({
    assetId,
    kind: event.kind,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    subject: event.subject ?? '',
    actorUserId,
    actorServiceAccountId,
  });
  const changes: Partial<typeof assets.$inferInsert> = {
    updatedAt: new Date(),
    updatedByUserId: actorUserId,
    updatedByServiceAccountId: actorServiceAccountId,
  };
  if (event.toStatus) changes.status = event.toStatus;
  await tx.update(assets).set(changes).where(eq(assets.id, assetId));
}

function describeAssignment(assignee: string, location: string): string {
  return [assignee, location].filter((s) => s !== '').join(', ');
}

async function loadHistory(db: Db, assetId: string): Promise<AssetHistory> {
  const startUser = aliasedTable(users, 'start_user');
  const startSa = aliasedTable(serviceAccounts, 'start_sa');
  const endUser = aliasedTable(users, 'end_user');
  const endSa = aliasedTable(serviceAccounts, 'end_sa');

  const [assignmentRows, repairRows, eventRows] = await Promise.all([
    db
      .select({
        row: assetAssignments,
        startUser: startUser.name,
        startSa: startSa.name,
        endUser: endUser.name,
        endSa: endSa.name,
      })
      .from(assetAssignments)
      .leftJoin(startUser, eq(startUser.id, assetAssignments.startedByUserId))
      .leftJoin(startSa, eq(startSa.id, assetAssignments.startedByServiceAccountId))
      .leftJoin(endUser, eq(endUser.id, assetAssignments.endedByUserId))
      .leftJoin(endSa, eq(endSa.id, assetAssignments.endedByServiceAccountId))
      .where(eq(assetAssignments.assetId, assetId))
      .orderBy(desc(assetAssignments.startedAt), desc(assetAssignments.id)),
    db
      .select({
        row: repairs,
        startUser: startUser.name,
        startSa: startSa.name,
        endUser: endUser.name,
        endSa: endSa.name,
      })
      .from(repairs)
      .leftJoin(startUser, eq(startUser.id, repairs.openedByUserId))
      .leftJoin(startSa, eq(startSa.id, repairs.openedByServiceAccountId))
      .leftJoin(endUser, eq(endUser.id, repairs.closedByUserId))
      .leftJoin(endSa, eq(endSa.id, repairs.closedByServiceAccountId))
      .where(eq(repairs.assetId, assetId))
      .orderBy(desc(repairs.openedAt), desc(repairs.id)),
    db
      .select({ row: assetEvents, userName: users.name, saName: serviceAccounts.name })
      .from(assetEvents)
      .leftJoin(users, eq(users.id, assetEvents.actorUserId))
      .leftJoin(serviceAccounts, eq(serviceAccounts.id, assetEvents.actorServiceAccountId))
      .where(eq(assetEvents.assetId, assetId))
      .orderBy(desc(assetEvents.at), desc(assetEvents.id)),
  ]);

  return {
    assignments: assignmentRows.map(({ row, ...names }) => ({
      id: row.id,
      assignee: row.assignee,
      location: row.location,
      notes: row.notes,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      startedBy: actorName(names.startUser, names.startSa),
      endedBy: actorName(names.endUser, names.endSa),
    })),
    repairs: repairRows.map(({ row, ...names }) => ({
      id: row.id,
      summary: row.summary,
      notes: row.notes,
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      openedBy: actorName(names.startUser, names.startSa),
      closedBy: actorName(names.endUser, names.endSa),
    })),
    activity: eventRows.map(({ row, userName, saName }) => ({
      id: row.id,
      kind: row.kind,
      at: row.at.toISOString(),
      by: actorName(userName, saName),
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      subject: row.subject,
    })),
  };
}

/** Ends the open assignment, if any, and returns what it described. */
async function endOpenAssignment(tx: Tx, request: FastifyRequest, assetId: string) {
  const { actorUserId, actorServiceAccountId } = actorOf(request);
  const [ended] = await tx
    .update(assetAssignments)
    .set({
      endedAt: sql`greatest(now(), ${assetAssignments.startedAt})`,
      endedByUserId: actorUserId,
      endedByServiceAccountId: actorServiceAccountId,
    })
    .where(and(eq(assetAssignments.assetId, assetId), isNull(assetAssignments.endedAt)))
    .returning({ assignee: assetAssignments.assignee, location: assetAssignments.location });
  return ended;
}

export function registerAssetHistoryRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  const writeResponses = {
    200: assetSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  };

  /** Runs a locked history change and answers with the updated asset, or the refusal. */
  async function change(
    request: FastifyRequest,
    reply: FastifyReply,
    assetId: string,
    work: (tx: Tx, status: AssetStatus) => Promise<Refusal | undefined>,
  ) {
    try {
      const outcome = await db.transaction(async (tx) => {
        const current = await lockAsset(tx, assetId);
        if (!current) return NOT_FOUND;
        return work(tx, current.status);
      });
      if (outcome === NOT_FOUND) return reply.code(404).send(NOT_FOUND);
      if (outcome) return reply.code(409).send(outcome);
      return await loadWrittenAsset(db, assetId);
    } catch (err) {
      // Only reachable if the row lock is bypassed; the partial unique indexes hold regardless.
      if (
        isUniqueViolation(err, 'asset_assignments_one_open') ||
        isUniqueViolation(err, 'repairs_one_open')
      ) {
        return reply.code(409).send(CHANGED);
      }
      throw err;
    }
  }

  r.get(
    '/api/assets/:id/history',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'Assignment history, repairs and activity for one asset, newest first',
        tags: ['assets'],
        params: idParams,
        response: { 200: assetHistorySchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const [exists] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, request.params.id));
      if (!exists) return reply.code(404).send(NOT_FOUND);
      return loadHistory(db, request.params.id);
    },
  );

  r.get(
    '/api/assets/assignment-suggestions',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'People and locations used in earlier assignments, for autocomplete',
        tags: ['assets'],
        querystring: z.object({ q: z.string().trim().max(200).default('') }),
        response: { 200: assignmentSuggestionsSchema },
      },
    },
    async (request) => {
      const pattern = `%${request.query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const distinct = (
        column: typeof assetAssignments.assignee | typeof assetAssignments.location,
      ) =>
        db
          .selectDistinct({ value: column })
          .from(assetAssignments)
          .where(and(ne(column, ''), ilike(column, pattern)))
          .orderBy(column)
          .limit(50);
      const [assignees, locations] = await Promise.all([
        distinct(assetAssignments.assignee),
        distinct(assetAssignments.location),
      ]);
      return {
        assignees: assignees.map((a) => a.value),
        locations: locations.map((l) => l.value),
      };
    },
  );

  r.post(
    '/api/assets/:id/assign',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Assign an asset to a person and/or location; reassigns if already assigned',
        description:
          'Ends any open assignment and starts a new one, setting the status to Deployed. Refused while the asset is in repair or retired.',
        tags: ['assets'],
        params: idParams,
        body: assignAssetRequestSchema,
        response: writeResponses,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { assignee, location, notes } = request.body;
      return change(request, reply, id, async (tx, status) => {
        if (status === 'retired') return RETIRED;
        if (status === 'in_repair') return IN_REPAIR;
        const { actorUserId, actorServiceAccountId } = actorOf(request);
        const previous = await endOpenAssignment(tx, request, id);
        if (previous) {
          await recordAssetChange(tx, request, id, {
            kind: 'returned',
            subject: describeAssignment(previous.assignee, previous.location),
          });
        }
        await tx.insert(assetAssignments).values({
          assetId: id,
          assignee,
          location,
          notes,
          startedByUserId: actorUserId,
          startedByServiceAccountId: actorServiceAccountId,
        });
        await recordAssetChange(tx, request, id, {
          kind: 'assigned',
          subject: describeAssignment(assignee, location),
          ...(status === 'deployed' ? {} : { fromStatus: status, toStatus: 'deployed' }),
        });
        return undefined;
      });
    },
  );

  r.post(
    '/api/assets/:id/return',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'End the open assignment; the asset goes back to In stock, or is retired',
        tags: ['assets'],
        params: idParams,
        body: returnAssetRequestSchema,
        response: writeResponses,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { status: next } = request.body;
      return change(request, reply, id, async (tx, status) => {
        if (status === 'in_repair') return IN_REPAIR;
        const ended = await endOpenAssignment(tx, request, id);
        if (!ended) {
          return refuse('not_assigned', 'This asset is not assigned to anyone. Reload the page.');
        }
        await recordAssetChange(tx, request, id, {
          kind: 'returned',
          subject: describeAssignment(ended.assignee, ended.location),
          fromStatus: status,
          toStatus: next,
        });
        return undefined;
      });
    },
  );

  r.post(
    '/api/assets/:id/repairs',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Open a repair; the asset moves to In repair until the repair is closed',
        description: 'Any assignment stays open, so the asset goes back to its holder afterwards.',
        tags: ['assets'],
        params: idParams,
        body: openRepairRequestSchema,
        response: writeResponses,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { summary, notes } = request.body;
      return change(request, reply, id, async (tx, status) => {
        if (status === 'retired') return RETIRED;
        if (status === 'in_repair') {
          return refuse(
            'repair_open',
            'This asset already has an open repair. Close it before logging another.',
          );
        }
        const { actorUserId, actorServiceAccountId } = actorOf(request);
        // The insert trigger sets the asset to in repair.
        await tx.insert(repairs).values({
          assetId: id,
          summary,
          notes,
          previousStatus: status,
          openedByUserId: actorUserId,
          openedByServiceAccountId: actorServiceAccountId,
        });
        await recordAssetChange(tx, request, id, {
          kind: 'repair_opened',
          subject: summary,
          fromStatus: status,
          toStatus: 'in_repair',
        });
        return undefined;
      });
    },
  );

  r.post(
    '/api/assets/:id/repairs/:repairId/close',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Close an open repair; the asset returns to the status it had before',
        tags: ['assets'],
        params: z.object({ id: z.uuid(), repairId: z.uuid() }),
        body: closeRepairRequestSchema,
        response: writeResponses,
      },
    },
    async (request, reply) => {
      const { id, repairId } = request.params;
      const { notes } = request.body;
      return change(request, reply, id, async (tx, status) => {
        const { actorUserId, actorServiceAccountId } = actorOf(request);
        const [closed] = await tx
          .update(repairs)
          .set({
            closedAt: sql`greatest(now(), ${repairs.openedAt})`,
            closedByUserId: actorUserId,
            closedByServiceAccountId: actorServiceAccountId,
            ...(notes === undefined ? {} : { notes }),
          })
          .where(and(eq(repairs.id, repairId), eq(repairs.assetId, id), isNull(repairs.closedAt)))
          .returning({ summary: repairs.summary, previousStatus: repairs.previousStatus });
        if (!closed) {
          return refuse('repair_not_open', 'That repair is already closed. Reload the page.');
        }
        await recordAssetChange(tx, request, id, {
          kind: 'repair_closed',
          subject: closed.summary,
          fromStatus: status,
          toStatus: closed.previousStatus,
        });
        return undefined;
      });
    },
  );
}

/** For refusals on the plain asset PATCH: a status that only history can change. */
export function lockedStatusRefusal(status: AssetStatus): Refusal | undefined {
  if (status === 'deployed') {
    return refuse(
      'status_from_assignment',
      `This asset is ${assetStatusLabels.deployed}. Return it to change its status.`,
    );
  }
  if (status === 'in_repair') return IN_REPAIR;
  return undefined;
}
