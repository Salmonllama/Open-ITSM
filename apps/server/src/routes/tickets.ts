import {
  addTicketMessageRequestSchema,
  OUTBOUND_ATTACHMENTS_MAX_BYTES,
  createTicketRequestSchema,
  errorResponseSchema,
  linkTicketAssetRequestSchema,
  OPEN_TICKET_STATUSES,
  requesterListSchema,
  requesterQuerySchema,
  ticketAssigneeListSchema,
  ticketDetailSchema,
  ticketListQuerySchema,
  ticketListResponseSchema,
  updateTicketRequestSchema,
  type TicketAttachment,
  type TicketDetail,
  type TicketListQuery,
  type TicketListResponse,
  type TicketStatus,
  type TicketSummary,
  type UserRef,
} from '@open-itsm/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, STAFF_ROLES } from '../auth/http.js';
import type { Db } from '../db/client.js';
import {
  assets,
  assetTypes,
  requesters,
  serviceAccounts,
  ticketAttachments,
  ticketAssets,
  ticketEvents,
  ticketMessages,
  ticketReads,
  tickets,
  users,
} from '../db/schema.js';
import { actorName } from './asset-history.js';
import { likePattern } from './assets.js';
import { STAFF_ONLY, TICKETS_READ, TICKETS_WRITE, type RouteDeps } from './deps.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Pick<Db, 'select'>;

const idParams = z.object({ id: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That ticket no longer exists. Reload the page.',
} as const;

const NOT_STAFF = {
  error: 'assignee_not_staff',
  message: 'Tickets can be assigned only to active administrators and technicians. Choose another.',
} as const;

const BAD_FILES = {
  error: 'attachment_not_found',
  message: 'An attached file is no longer waiting to be sent. Attach it again.',
} as const;

const TOO_LARGE = {
  error: 'attachments_too_large',
  message:
    'Attachments on one reply can total at most 25 MB. Remove some, or share a link instead.',
} as const;

const NO_ASSET = {
  error: 'asset_not_found',
  message: 'That asset no longer exists. Search for it again.',
} as const;

/** Rolls back a new ticket when an asset to link does not exist. */
class MissingAsset extends Error {}

const OPEN = [...OPEN_TICKET_STATUSES];
const DONE: TicketStatus[] = ['resolved', 'closed'];

const assignee = alias(users, 'assignee');

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** The signed-in user, or null for a token: a service account is nobody's "me". */
function meOf(request: FastifyRequest): string | null {
  return request.session?.user.id ?? null;
}

const summaryColumns = {
  row: tickets,
  assigneeName: assignee.name,
  requesterName: requesters.name,
  requesterEmail: requesters.email,
  readAt: ticketReads.readAt,
} as const;

/** Tickets with their assignee, requester and when `me` last opened them. */
function selectSummaries(db: Executor, me: string | null) {
  return db
    .select(summaryColumns)
    .from(tickets)
    .innerJoin(requesters, eq(requesters.id, tickets.requesterId))
    .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
    .leftJoin(
      ticketReads,
      and(eq(ticketReads.ticketId, tickets.id), me ? eq(ticketReads.userId, me) : sql`false`),
    );
}

type SummaryRow = {
  row: typeof tickets.$inferSelect;
  assigneeName: string | null;
  requesterName: string;
  requesterEmail: string;
  readAt: Date | null;
};

function toSummary(r: SummaryRow, me: string | null): TicketSummary {
  const t = r.row;
  const lastAsked = t.lastRequesterMessageAt;
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    source: t.source,
    requester: { id: t.requesterId, name: r.requesterName, email: r.requesterEmail },
    assignee: t.assigneeId && r.assigneeName ? { id: t.assigneeId, name: r.assigneeName } : null,
    createdAt: t.createdAt.toISOString(),
    lastActivityAt: t.lastActivityAt.toISOString(),
    unread: me !== null && lastAsked !== null && (r.readAt === null || lastAsked > r.readAt),
  };
}

/** A search matches the number (with or without #), subject, requester or a linked asset. */
function searchCondition(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const pattern = likePattern(q);
  const number = /^#?(\d{1,9})$/.exec(q)?.[1];
  return or(
    number ? eq(tickets.number, Number(number)) : undefined,
    ilike(tickets.subject, pattern),
    sql`exists (select 1 from ${requesters} where ${requesters.id} = ${tickets.requesterId} and (${requesters.name} ilike ${pattern} or ${requesters.email} ilike ${pattern}))`,
    sql`exists (select 1 from ${ticketAssets} join ${assets} on ${assets.id} = ${ticketAssets.assetId} where ${ticketAssets.ticketId} = ${tickets.id} and ${assets.number} ilike ${pattern})`,
  );
}

function queueCondition(queue: NonNullable<TicketListQuery['queue']>, me: string | null): SQL {
  switch (queue) {
    case 'open':
      return inArray(tickets.status, OPEN);
    case 'unassigned':
      return and(inArray(tickets.status, OPEN), isNull(tickets.assigneeId)) as SQL;
    case 'mine':
      return me
        ? (and(inArray(tickets.status, OPEN), eq(tickets.assigneeId, me)) as SQL)
        : sql`false`;
    case 'waiting':
      return eq(tickets.status, 'waiting_on_user');
    case 'closed':
      return inArray(tickets.status, DONE);
  }
}

async function loadUserRefs(db: Executor, ids: string[]): Promise<Map<string, UserRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((u) => [u.id, u]));
}

async function loadDetail(
  db: Executor,
  where: SQL,
  me: string | null,
): Promise<TicketDetail | undefined> {
  const [found] = await selectSummaries(db, me).where(where);
  if (!found) return undefined;
  const t = found.row;
  const [messages, events, [others], linked, files] = await Promise.all([
    db
      .select({ row: ticketMessages, userName: users.name, saName: serviceAccounts.name })
      .from(ticketMessages)
      .leftJoin(users, eq(users.id, ticketMessages.actorUserId))
      .leftJoin(serviceAccounts, eq(serviceAccounts.id, ticketMessages.actorServiceAccountId))
      .where(eq(ticketMessages.ticketId, t.id))
      .orderBy(asc(ticketMessages.at), asc(ticketMessages.id)),
    db
      .select({
        row: ticketEvents,
        userName: users.name,
        saName: serviceAccounts.name,
        assetExists: assets.id,
      })
      .from(ticketEvents)
      .leftJoin(users, eq(users.id, ticketEvents.actorUserId))
      .leftJoin(serviceAccounts, eq(serviceAccounts.id, ticketEvents.actorServiceAccountId))
      .leftJoin(assets, eq(assets.id, ticketEvents.assetId))
      .where(eq(ticketEvents.ticketId, t.id))
      .orderBy(desc(ticketEvents.at), desc(ticketEvents.id)),
    db
      .select({ n: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.requesterId, t.requesterId),
          inArray(tickets.status, OPEN),
          ne(tickets.id, t.id),
        ),
      ),
    db
      .select({
        id: assets.id,
        number: assets.number,
        name: assets.name,
        status: assets.status,
        type: assetTypes.name,
      })
      .from(ticketAssets)
      .innerJoin(assets, eq(assets.id, ticketAssets.assetId))
      .innerJoin(assetTypes, eq(assetTypes.id, assets.assetTypeId))
      .where(eq(ticketAssets.ticketId, t.id))
      .orderBy(asc(ticketAssets.linkedAt), asc(assets.number)),
    db
      .select({
        id: ticketAttachments.id,
        messageId: ticketAttachments.messageId,
        name: ticketAttachments.name,
        contentType: ticketAttachments.contentType,
        size: ticketAttachments.size,
        skippedReason: ticketAttachments.skippedReason,
      })
      .from(ticketAttachments)
      .where(eq(ticketAttachments.ticketId, t.id))
      .orderBy(asc(ticketAttachments.createdAt), asc(ticketAttachments.name)),
  ]);
  const filesByMessage = new Map<number, TicketAttachment[]>();
  for (const { messageId, ...file } of files) {
    if (messageId === null) continue;
    filesByMessage.set(messageId, [...(filesByMessage.get(messageId) ?? []), file]);
  }
  const people = await loadUserRefs(db, [
    ...new Set(
      events
        .flatMap((e) => [e.row.fromAssigneeId, e.row.toAssigneeId])
        .filter((id): id is string => id !== null),
    ),
  ]);
  const person = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  return {
    ...toSummary(found, me),
    firstResponseAt: iso(t.firstResponseAt),
    lastRequesterMessageAt: iso(t.lastRequesterMessageAt),
    requesterOpenTickets: others?.n ?? 0,
    linkedAssets: linked,
    messages: messages.map((m) => ({
      id: m.row.id,
      kind: m.row.kind,
      body: m.row.body,
      at: m.row.at.toISOString(),
      by: actorName(m.userName, m.saName),
      from:
        m.row.kind === 'inbound' && m.row.fromEmail !== null
          ? { name: m.row.fromName ?? '', email: m.row.fromEmail }
          : null,
      emailedAt: iso(m.row.emailedAt),
      emailStatus: m.row.emailStatus,
      emailError: m.row.emailError,
      attachments: filesByMessage.get(m.row.id) ?? [],
    })),
    events: events.map((e) => ({
      id: e.row.id,
      kind: e.row.kind,
      fromStatus: e.row.fromStatus,
      toStatus: e.row.toStatus,
      fromAssignee: person(e.row.fromAssigneeId),
      toAssignee: person(e.row.toAssigneeId),
      asset: e.row.assetNumber !== null ? { id: e.assetExists, number: e.row.assetNumber } : null,
      at: e.row.at.toISOString(),
      by: actorName(e.userName, e.saName),
    })),
  };
}

/** After a write in a committed transaction, the ticket is there: tickets are never deleted. */
async function loadWritten(db: Executor, request: FastifyRequest, id: string) {
  const detail = await loadDetail(db, eq(tickets.id, id), meOf(request));
  if (!detail) throw new Error(`ticket ${id} vanished after a write`);
  return detail;
}

/** Whoever works a ticket has seen it, so their own changes never mark it unread. */
async function markRead(tx: Pick<Db, 'insert'>, request: FastifyRequest, id: string, at: Date) {
  const me = meOf(request);
  if (!me) return;
  await tx
    .insert(ticketReads)
    .values({ ticketId: id, userId: me, readAt: at })
    .onConflictDoUpdate({
      target: [ticketReads.ticketId, ticketReads.userId],
      set: { readAt: sql`greatest(${ticketReads.readAt}, excluded.read_at)` },
    });
}

type Current = { status: TicketStatus; assigneeId: string | null };

/**
 * Applies a status and assignee change to a locked ticket and records an event for each part
 * that changed. Assigning a New ticket moves it to In progress unless a status is given.
 */
async function applyChange(
  tx: Tx,
  request: FastifyRequest,
  id: string,
  current: Current,
  change: { status?: TicketStatus; assigneeId?: string | null },
  now: Date,
): Promise<void> {
  const actor = actorOf(request);
  const assigneeChanged =
    change.assigneeId !== undefined && change.assigneeId !== current.assigneeId;
  let status = change.status;
  if (status === undefined && assigneeChanged && change.assigneeId && current.status === 'new') {
    status = 'in_progress';
  }
  const statusChanged = status !== undefined && status !== current.status;
  if (!assigneeChanged && !statusChanged) return;

  await tx
    .update(tickets)
    .set({
      ...(statusChanged ? { status } : {}),
      ...(assigneeChanged ? { assigneeId: change.assigneeId } : {}),
      lastActivityAt: now,
    })
    .where(eq(tickets.id, id));
  if (assigneeChanged) {
    await tx.insert(ticketEvents).values({
      ticketId: id,
      kind: 'assignee',
      fromAssigneeId: current.assigneeId,
      toAssigneeId: change.assigneeId ?? null,
      at: now,
      ...actor,
    });
  }
  if (statusChanged) {
    await tx.insert(ticketEvents).values({
      ticketId: id,
      kind: 'status',
      fromStatus: current.status,
      toStatus: status,
      at: now,
      ...actor,
    });
  }
}

async function lockTicket(tx: Tx, id: string): Promise<Current | undefined> {
  const [row] = await tx
    .select({ status: tickets.status, assigneeId: tickets.assigneeId })
    .from(tickets)
    .where(eq(tickets.id, id))
    .for('update');
  return row;
}

async function isAssignable(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), inArray(users.role, STAFF_ROLES), isNull(users.disabledAt)));
  return row !== undefined;
}

/** Links assets that are not linked yet and records each; false if one does not exist. */
async function linkAssets(
  tx: Tx,
  request: FastifyRequest,
  ticketId: string,
  assetIds: string[],
  now: Date,
): Promise<boolean> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return true;
  const found = await tx
    .select({ id: assets.id, number: assets.number })
    .from(assets)
    .where(inArray(assets.id, ids));
  if (found.length !== ids.length) return false;
  const added = await tx
    .insert(ticketAssets)
    .values(found.map((a) => ({ ticketId, assetId: a.id, linkedAt: now })))
    .onConflictDoNothing()
    .returning({ assetId: ticketAssets.assetId });
  for (const { assetId } of added) {
    await tx.insert(ticketEvents).values({
      ticketId,
      kind: 'asset_linked',
      assetId,
      assetNumber: found.find((a) => a.id === assetId)?.number ?? '',
      at: now,
      ...actorOf(request),
    });
  }
  if (added.length > 0) {
    await tx.update(tickets).set({ lastActivityAt: now }).where(eq(tickets.id, ticketId));
  }
  return true;
}

export function registerTicketRoutes(app: FastifyInstance, { db, mail }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/tickets',
    {
      config: { access: TICKETS_READ },
      schema: {
        summary: 'Search tickets, a page at a time, newest activity first',
        description:
          'Queues: `open` (New, In progress, Waiting on user), `unassigned` and `mine` (open ones), `waiting` (Waiting on user) and `closed` (Resolved and Closed). `mine` is always empty for a token. `counts` gives the size of each queue for the same search.',
        tags: ['tickets'],
        querystring: ticketListQuerySchema,
        response: { 200: ticketListResponseSchema },
      },
    },
    async (request): Promise<TicketListResponse> => {
      const { q, queue, status, assignee: who, source, page, pageSize } = request.query;
      const me = meOf(request);
      const search = searchCondition(q);
      const filters: (SQL | undefined)[] = [search, queueCondition(queue, me)];
      if (status) filters.push(eq(tickets.status, status));
      if (source) filters.push(eq(tickets.source, source));
      if (who === 'none') filters.push(isNull(tickets.assigneeId));
      else if (who === 'me') filters.push(me ? eq(tickets.assigneeId, me) : sql`false`);
      else if (who) filters.push(eq(tickets.assigneeId, who));
      const where = and(...filters);

      const isOpen = sql`${tickets.status} in ('new', 'in_progress', 'waiting_on_user')`;
      const counted = (condition: SQL) =>
        sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
      const [rows, [total], [counts]] = await Promise.all([
        selectSummaries(db, me)
          .where(where)
          .orderBy(desc(tickets.lastActivityAt), desc(tickets.number))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db.select({ n: count() }).from(tickets).where(where),
        db
          .select({
            open: counted(isOpen),
            unassigned: counted(sql`${isOpen} and ${tickets.assigneeId} is null`),
            mine: counted(me ? sql`${isOpen} and ${tickets.assigneeId} = ${me}` : sql`false`),
            waiting: counted(sql`${tickets.status} = 'waiting_on_user'`),
            closed: counted(sql`${tickets.status} in ('resolved', 'closed')`),
          })
          .from(tickets)
          .where(search),
      ]);
      return {
        items: rows.map((row) => toSummary(row, me)),
        total: total?.n ?? 0,
        page,
        pageSize,
        counts: counts ?? { open: 0, unassigned: 0, mine: 0, waiting: 0, closed: 0 },
      };
    },
  );

  r.get(
    '/api/tickets/assignees',
    {
      config: { access: TICKETS_READ },
      schema: {
        summary: 'Staff a ticket can be assigned to: active administrators and technicians',
        tags: ['tickets'],
        response: { 200: ticketAssigneeListSchema },
      },
    },
    async () =>
      db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(inArray(users.role, STAFF_ROLES), isNull(users.disabledAt)))
        .orderBy(asc(sql`lower(${users.name})`)),
  );

  r.get(
    '/api/requesters',
    {
      config: { access: TICKETS_READ },
      schema: {
        summary: 'People who have raised tickets, by name or email, for suggestions',
        description: 'At most 20, by name.',
        tags: ['tickets'],
        querystring: requesterQuerySchema,
        response: { 200: requesterListSchema },
      },
    },
    async (request) => {
      const { q } = request.query;
      const pattern = q ? likePattern(q) : undefined;
      return db
        .select({ id: requesters.id, name: requesters.name, email: requesters.email })
        .from(requesters)
        .where(
          pattern
            ? or(ilike(requesters.name, pattern), ilike(requesters.email, pattern))
            : undefined,
        )
        .orderBy(asc(sql`lower(${requesters.name})`), asc(requesters.email))
        .limit(20);
    },
  );

  r.get(
    '/api/tickets/by-number/:number',
    {
      config: { access: TICKETS_READ },
      schema: {
        summary: 'Find a ticket by its number, such as 42',
        tags: ['tickets'],
        params: z.object({ number: z.coerce.number().int().min(1).max(2_147_483_647) }),
        response: { 200: ticketDetailSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const detail = await loadDetail(db, eq(tickets.number, request.params.number), meOf(request));
      return (
        detail ??
        reply.code(404).send({
          error: 'not_found',
          message: `No ticket has the number #${request.params.number}.`,
        })
      );
    },
  );

  r.get(
    '/api/tickets/:id',
    {
      config: { access: TICKETS_READ },
      schema: {
        summary: 'One ticket with its conversation, linked assets and history',
        tags: ['tickets'],
        params: idParams,
        response: { 200: ticketDetailSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const detail = await loadDetail(db, eq(tickets.id, request.params.id), meOf(request));
      return detail ?? reply.code(404).send(NOT_FOUND);
    },
  );

  r.post(
    '/api/tickets/:id/read',
    {
      config: { access: STAFF_ONLY },
      schema: {
        summary: 'Mark a ticket as read by you, which clears its unread dot',
        tags: ['tickets'],
        params: idParams,
        response: { 204: z.null(), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const [row] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.id, request.params.id));
      if (!row) return reply.code(404).send(NOT_FOUND);
      await markRead(db, request, row.id, new Date());
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/api/tickets',
    {
      config: { access: TICKETS_WRITE },
      schema: {
        summary: 'Open a ticket for a requester, with what they asked as its first message',
        description:
          'Email to the support mailbox opens tickets on its own (source `email`). Technicians can also open one from the dashboard, and scripts with a token; the source is `dashboard` or `api` accordingly. The requester is found by email, or added; a blank name on a known requester is filled in.',
        tags: ['tickets'],
        body: createTicketRequestSchema,
        response: { 201: ticketDetailSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { subject, requester, message, assetIds } = request.body;
      const actor = actorOf(request);
      const id = await db
        .transaction(async (tx: Tx) => {
          const now = new Date();
          const [person] = await tx
            .insert(requesters)
            .values({ name: requester.name, email: requester.email })
            .onConflictDoUpdate({
              target: requesters.email,
              set: {
                name: sql`case when ${requesters.name} = '' then excluded.name else ${requesters.name} end`,
              },
            })
            .returning({ id: requesters.id, name: requesters.name });
          if (!person) throw new Error('requester upsert returned nothing');
          const [row] = await tx
            .insert(tickets)
            .values({
              subject,
              source: request.apiToken ? 'api' : 'dashboard',
              requesterId: person.id,
              createdAt: now,
              lastActivityAt: now,
              lastRequesterMessageAt: now,
            })
            .returning({ id: tickets.id });
          if (!row) throw new Error('insert returned nothing');
          await tx.insert(ticketMessages).values({
            ticketId: row.id,
            kind: 'inbound',
            body: message,
            fromName: person.name,
            fromEmail: requester.email,
            at: now,
            ...actor,
          });
          await tx.insert(ticketEvents).values({
            ticketId: row.id,
            kind: 'created',
            toStatus: 'new',
            at: now,
            ...actor,
          });
          if (!(await linkAssets(tx, request, row.id, assetIds, now))) throw new MissingAsset();
          await markRead(tx, request, row.id, now);
          return row.id;
        })
        .catch((err: unknown) => {
          if (err instanceof MissingAsset) return undefined;
          throw err;
        });
      if (!id) return reply.code(409).send(NO_ASSET);
      return reply.code(201).send(await loadWritten(db, request, id));
    },
  );

  r.patch(
    '/api/tickets/:id',
    {
      config: { access: TICKETS_WRITE },
      schema: {
        summary: "Change a ticket's status or assignee",
        description:
          'Set `assigneeId` to a staff member, or to null to unassign. Assigning a New ticket moves it to In progress unless `status` is also given. Any status but New can be set, so a closed ticket is reopened by setting it to In progress.',
        tags: ['tickets'],
        params: idParams,
        body: updateTicketRequestSchema,
        response: {
          200: ticketDetailSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { status, assigneeId } = request.body;
      const outcome = await db.transaction(async (tx: Tx) => {
        const current = await lockTicket(tx, id);
        if (!current) return NOT_FOUND;
        if (
          assigneeId &&
          assigneeId !== current.assigneeId &&
          !(await isAssignable(tx, assigneeId))
        ) {
          return NOT_STAFF;
        }
        const now = new Date();
        await applyChange(tx, request, id, current, { status, assigneeId }, now);
        await markRead(tx, request, id, now);
        return undefined;
      });
      if (outcome === NOT_FOUND) return reply.code(404).send(NOT_FOUND);
      if (outcome) return reply.code(409).send(outcome);
      return loadWritten(db, request, id);
    },
  );

  r.post(
    '/api/tickets/:id/messages',
    {
      config: { access: TICKETS_WRITE },
      schema: {
        summary: 'Reply to the requester or add an internal note',
        description:
          'A reply to a New ticket moves it to In progress unless `status` is given. Notes are for staff only, are never emailed and never change the status on their own. A reply is emailed to the requester when the mailbox is connected (`emailStatus` `queued`, then `sent` or `failed`); otherwise it is saved only (`not_sent`). `attachmentIds` are files uploaded to this ticket first with `POST /api/tickets/:id/attachments`.',
        tags: ['tickets'],
        params: idParams,
        body: addTicketMessageRequestSchema,
        response: { 200: ticketDetailSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { kind, body, status, attachmentIds } = request.body;
      const emailing = kind === 'reply' && (await mail.canSend());
      const outcome = await db.transaction(async (tx: Tx) => {
        const current = await lockTicket(tx, id);
        if (!current) return NOT_FOUND;
        const fileIds = [...new Set(attachmentIds)];
        if (fileIds.length > 0) {
          const pending = await tx
            .select({ id: ticketAttachments.id, size: ticketAttachments.size })
            .from(ticketAttachments)
            .where(
              and(
                inArray(ticketAttachments.id, fileIds),
                eq(ticketAttachments.ticketId, id),
                isNull(ticketAttachments.messageId),
              ),
            )
            .for('update');
          if (pending.length !== fileIds.length) return BAD_FILES;
          const total = pending.reduce((sum, f) => sum + f.size, 0);
          if (kind === 'reply' && total > OUTBOUND_ATTACHMENTS_MAX_BYTES) return TOO_LARGE;
        }
        const now = new Date();
        const [message] = await tx
          .insert(ticketMessages)
          .values({
            ticketId: id,
            kind,
            body,
            at: now,
            ...(kind === 'reply' ? { emailStatus: emailing ? 'queued' : 'not_sent' } : {}),
            ...actorOf(request),
          })
          .returning({ id: ticketMessages.id });
        if (!message) throw new Error('message insert returned nothing');
        if (fileIds.length > 0) {
          await tx
            .update(ticketAttachments)
            .set({ messageId: message.id })
            .where(inArray(ticketAttachments.id, fileIds));
        }
        await tx
          .update(tickets)
          .set({
            lastActivityAt: now,
            ...(kind === 'reply'
              ? {
                  firstResponseAt: sql`coalesce(${tickets.firstResponseAt}, ${now.toISOString()}::timestamptz)`,
                }
              : {}),
          })
          .where(eq(tickets.id, id));
        const next =
          status ?? (kind === 'reply' && current.status === 'new' ? 'in_progress' : undefined);
        await applyChange(tx, request, id, current, { status: next }, now);
        await markRead(tx, request, id, now);
        return message.id;
      });
      if (outcome === NOT_FOUND) return reply.code(404).send(NOT_FOUND);
      if (typeof outcome !== 'number') return reply.code(409).send(outcome);
      if (emailing) await mail.queue.send(outcome);
      return loadWritten(db, request, id);
    },
  );

  r.post(
    '/api/tickets/:id/messages/:messageId/resend',
    {
      config: { access: TICKETS_WRITE },
      schema: {
        summary: 'Try again to email a reply that failed',
        tags: ['tickets'],
        params: z.object({ id: z.uuid(), messageId: z.coerce.number().int().min(1) }),
        response: { 200: ticketDetailSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, messageId } = request.params;
      if (!(await mail.canSend())) {
        return reply.code(409).send({
          error: 'mail_off',
          message:
            'No mailbox is connected, or it is switched off. An administrator can connect it under Email.',
        });
      }
      const [updated] = await db
        .update(ticketMessages)
        .set({ emailStatus: 'queued', emailError: null })
        .where(
          and(
            eq(ticketMessages.id, messageId),
            eq(ticketMessages.ticketId, id),
            eq(ticketMessages.emailStatus, 'failed'),
          ),
        )
        .returning({ id: ticketMessages.id });
      if (!updated) {
        return reply.code(409).send({
          error: 'not_failed',
          message: 'Only a reply that failed to send can be sent again. Reload the page.',
        });
      }
      await mail.queue.send(updated.id);
      return loadWritten(db, request, id);
    },
  );

  r.post(
    '/api/tickets/:id/assets',
    {
      config: { access: TICKETS_WRITE },
      schema: {
        summary: 'Link an asset to a ticket',
        description: 'Linking an asset that is already linked changes nothing.',
        tags: ['tickets'],
        params: idParams,
        body: linkTicketAssetRequestSchema,
        response: { 200: ticketDetailSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const outcome = await db.transaction(async (tx: Tx) => {
        if (!(await lockTicket(tx, id))) return NOT_FOUND;
        const now = new Date();
        if (!(await linkAssets(tx, request, id, [request.body.assetId], now))) return NO_ASSET;
        await markRead(tx, request, id, now);
        return undefined;
      });
      if (outcome === NOT_FOUND) return reply.code(404).send(NOT_FOUND);
      if (outcome) return reply.code(409).send(outcome);
      return loadWritten(db, request, id);
    },
  );

  r.delete(
    '/api/tickets/:id/assets/:assetId',
    {
      config: { access: TICKETS_WRITE },
      schema: {
        summary: 'Unlink an asset from a ticket',
        description: 'The ticket history keeps a record that it was linked.',
        tags: ['tickets'],
        params: z.object({ id: z.uuid(), assetId: z.uuid() }),
        response: { 200: ticketDetailSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, assetId } = request.params;
      const found = await db.transaction(async (tx: Tx) => {
        if (!(await lockTicket(tx, id))) return false;
        const now = new Date();
        const [removed] = await tx
          .delete(ticketAssets)
          .where(and(eq(ticketAssets.ticketId, id), eq(ticketAssets.assetId, assetId)))
          .returning({ assetId: ticketAssets.assetId });
        if (removed) {
          const [asset] = await tx
            .select({ number: assets.number })
            .from(assets)
            .where(eq(assets.id, assetId));
          await tx.insert(ticketEvents).values({
            ticketId: id,
            kind: 'asset_unlinked',
            assetId,
            assetNumber: asset?.number ?? '',
            at: now,
            ...actorOf(request),
          });
          await tx.update(tickets).set({ lastActivityAt: now }).where(eq(tickets.id, id));
        }
        await markRead(tx, request, id, now);
        return true;
      });
      if (!found) return reply.code(404).send(NOT_FOUND);
      return loadWritten(db, request, id);
    },
  );
}
