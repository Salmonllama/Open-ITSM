import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_MESSAGE,
  isBlockedAttachment,
  TICKET_BODY_MAX,
  TICKET_SUBJECT_MAX,
  type TicketStatus,
} from '@open-itsm/shared';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { cleanFileName, type AttachmentStore } from '../attachments.js';
import type { Db } from '../db/client.js';
import {
  requesters,
  ticketAttachments,
  ticketEvents,
  ticketMessages,
  tickets,
} from '../db/schema.js';
import { GraphError, type GraphClient } from './graph.js';
import {
  isAutomated,
  messageBody,
  referencedMessageIds,
  ticketNumberInSubject,
  ticketSubject,
  type Header,
} from './headers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Immutable IDs survive a message being moved between folders; bodies come as plain text. */
export const PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';

const DELTA_SELECT = 'id,receivedDateTime,isDraft';
const MESSAGE_SELECT = [
  'id',
  'subject',
  'from',
  'sender',
  'receivedDateTime',
  'isDraft',
  'internetMessageId',
  'conversationId',
  'internetMessageHeaders',
  'body',
  'uniqueBody',
  'hasAttachments',
].join(',');

/** After this many failed attempts on one email, it is skipped so the rest still arrive. */
export const MAX_MESSAGE_FAILURES = 3;

type DeltaPage = {
  value: { id: string; receivedDateTime?: string; isDraft?: boolean; '@removed'?: unknown }[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
};

type EmailAddress = { name?: string; address?: string };

type GraphMessage = {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: EmailAddress } | null;
  sender?: { emailAddress?: EmailAddress } | null;
  receivedDateTime: string;
  isDraft?: boolean;
  internetMessageId?: string | null;
  conversationId?: string | null;
  internetMessageHeaders?: Header[] | null;
  body?: { content?: string } | null;
  uniqueBody?: { content?: string } | null;
  hasAttachments?: boolean;
};

type GraphAttachment = {
  '@odata.type'?: string;
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
};

export type PollState = {
  deltaLink?: string;
  /** Failed attempts per Graph message ID, so one bad email cannot block the inbox. */
  failures?: Record<string, number>;
};

export type PollResult = {
  state: PollState;
  created: number;
  appended: number;
  skipped: number;
};

export type PollContext = {
  db: Db;
  client: GraphClient;
  store: AttachmentStore;
  log: Logger;
  mailbox: string;
  /** Mail received before this is never turned into tickets. */
  connectedAt: Date;
};

/**
 * One round of the inbox delta query: every new email becomes a ticket or joins one. The new
 * delta link is returned only when the round finished, so a failed round is repeated (repeats
 * are recognised by Graph message ID and Message-ID and skipped).
 * `state.failures` is updated in place, so a caller keeps the count even when the round throws.
 */
export async function pollInbox(ctx: PollContext, state: PollState): Promise<PollResult> {
  const result: PollResult = { state: { ...state }, created: 0, appended: 0, skipped: 0 };
  const failures = (state.failures ??= {});
  // The first sync asks only for mail since the mailbox was connected; older mail stays put.
  const since = encodeURIComponent(`receivedDateTime ge ${ctx.connectedAt.toISOString()}`);
  const start = `${ctx.client.mailboxPath}/mailFolders/inbox/messages/delta?$select=${DELTA_SELECT}&$filter=${since}`;
  let url = state.deltaLink ?? start;
  for (;;) {
    let page: DeltaPage;
    try {
      page = await ctx.client.request<DeltaPage>('GET', url, { headers: { Prefer: PREFER } });
    } catch (err) {
      // An expired sync state: start over; repeats are skipped.
      if (err instanceof GraphError && err.status === 410 && url !== start) {
        ctx.log.warn('mailbox delta link expired; starting a new sync');
        url = start;
        continue;
      }
      throw err;
    }
    for (const item of page.value) {
      if (item['@removed'] || item.isDraft) continue;
      if (item.receivedDateTime && new Date(item.receivedDateTime) < ctx.connectedAt) continue;
      try {
        const outcome = await importMessage(ctx, item.id);
        if (outcome === 'created') result.created++;
        else if (outcome === 'appended') result.appended++;
        else result.skipped++;
        Reflect.deleteProperty(failures, item.id);
      } catch (err) {
        const count = (failures[item.id] ?? 0) + 1;
        if (count >= MAX_MESSAGE_FAILURES) {
          ctx.log.error({ err, graphMessageId: item.id }, 'skipping an email that keeps failing');
          Reflect.deleteProperty(failures, item.id);
          result.skipped++;
          continue;
        }
        failures[item.id] = count;
        throw err;
      }
    }
    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      continue;
    }
    result.state = { deltaLink: page['@odata.deltaLink'] ?? url, failures };
    return result;
  }
}

type Outcome = 'created' | 'appended' | 'skipped';

async function importMessage(ctx: PollContext, graphId: string): Promise<Outcome> {
  const { db, client, log } = ctx;
  const [seen] = await db
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(eq(ticketMessages.graphMessageId, graphId));
  if (seen) return 'skipped';

  const msg = await client.request<GraphMessage>(
    'GET',
    `${client.mailboxPath}/messages/${encodeURIComponent(graphId)}?$select=${MESSAGE_SELECT}`,
    { headers: { Prefer: PREFER } },
  );
  const received = new Date(msg.receivedDateTime);
  if (msg.isDraft || !(received >= ctx.connectedAt)) return 'skipped';
  const from = msg.from?.emailAddress ?? msg.sender?.emailAddress;
  const address = from?.address?.trim().toLowerCase();
  if (!address || !address.includes('@')) return 'skipped';
  const headers = msg.internetMessageHeaders ?? [];
  // Mail from the mailbox itself, and mail no person wrote, could start a loop.
  if (address === ctx.mailbox.toLowerCase() || isAutomated(headers, address)) {
    log.info({ graphMessageId: graphId }, 'skipped an automatic email or one from the mailbox');
    return 'skipped';
  }
  const internetId = msg.internetMessageId?.trim() || null;
  if (internetId) {
    const [dup] = await db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(eq(ticketMessages.internetMessageId, internetId), eq(ticketMessages.kind, 'inbound')),
      );
    if (dup) return 'skipped';
  }

  const ticketId = await findTicket(db, msg, headers);
  const files = msg.hasAttachments ? await downloadAttachments(ctx, graphId) : [];
  const name = (from?.name ?? '').trim().slice(0, 200);
  const body = messageBody(
    ticketId && msg.uniqueBody?.content?.trim() ? msg.uniqueBody.content : msg.body?.content,
    TICKET_BODY_MAX,
  );

  try {
    await db.transaction(async (tx: Tx) => {
      let id = ticketId;
      if (id) {
        await joinTicket(tx, id, received);
      } else {
        id = await openTicket(
          tx,
          ticketSubject(msg.subject, TICKET_SUBJECT_MAX),
          address,
          name,
          received,
        );
      }
      const [row] = await tx
        .insert(ticketMessages)
        .values({
          ticketId: id,
          kind: 'inbound',
          body,
          fromName: name,
          fromEmail: address,
          graphMessageId: graphId,
          internetMessageId: internetId,
          conversationId: msg.conversationId ?? null,
          at: received,
        })
        .returning({ id: ticketMessages.id });
      if (!row) throw new Error('message insert returned nothing');
      if (files.length > 0) {
        await tx
          .insert(ticketAttachments)
          .values(files.map((f) => ({ ...f, ticketId: id, messageId: row.id })));
      }
    });
  } catch (err) {
    await Promise.all(files.map((f) => (f.storageKey ? ctx.store.remove(f.storageKey) : null)));
    throw err;
  }
  return ticketId ? 'appended' : 'created';
}

/**
 * The ticket an email belongs to: by the `[#N]` reference in its subject first, then by the
 * message IDs it replies to, then by its Graph conversation ID. Undefined opens a new ticket.
 */
async function findTicket(db: Db, msg: GraphMessage, headers: Header[]) {
  const number = ticketNumberInSubject(msg.subject ?? '');
  if (number !== undefined) {
    const [row] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.number, number));
    if (row) return row.id;
  }
  const refs = referencedMessageIds(headers);
  if (refs.length > 0) {
    const rows = await db
      .select({ ticketId: ticketMessages.ticketId, id: ticketMessages.internetMessageId })
      .from(ticketMessages)
      .where(inArray(ticketMessages.internetMessageId, refs));
    for (const ref of refs) {
      const hit = rows.find((r) => r.id === ref);
      if (hit) return hit.ticketId;
    }
  }
  if (msg.conversationId) {
    const [row] = await db
      .select({ ticketId: ticketMessages.ticketId })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.conversationId, msg.conversationId),
          isNotNull(ticketMessages.ticketId),
        ),
      )
      .orderBy(desc(ticketMessages.at))
      .limit(1);
    if (row) return row.ticketId;
  }
  return undefined;
}

async function openTicket(tx: Tx, subject: string, email: string, name: string, at: Date) {
  const [person] = await tx
    .insert(requesters)
    .values({ name, email })
    .onConflictDoUpdate({
      target: requesters.email,
      set: {
        name: sql`case when ${requesters.name} = '' then excluded.name else ${requesters.name} end`,
      },
    })
    .returning({ id: requesters.id });
  if (!person) throw new Error('requester upsert returned nothing');
  const [ticket] = await tx
    .insert(tickets)
    .values({
      subject,
      source: 'email',
      requesterId: person.id,
      createdAt: at,
      lastActivityAt: at,
      lastRequesterMessageAt: at,
    })
    .returning({ id: tickets.id });
  if (!ticket) throw new Error('ticket insert returned nothing');
  await tx
    .insert(ticketEvents)
    .values({ ticketId: ticket.id, kind: 'created', toStatus: 'new', at });
  return ticket.id;
}

/** A reply on a ticket that was waiting or done puts it back in progress. */
const REOPENS: TicketStatus[] = ['waiting_on_user', 'resolved', 'closed'];

async function joinTicket(tx: Tx, id: string, at: Date) {
  const [current] = await tx
    .select({ status: tickets.status })
    .from(tickets)
    .where(eq(tickets.id, id))
    .for('update');
  if (!current) throw new Error(`ticket ${id} vanished`);
  const now = new Date();
  await tx
    .update(tickets)
    .set({
      lastActivityAt: sql`greatest(${tickets.lastActivityAt}, ${now.toISOString()}::timestamptz)`,
      lastRequesterMessageAt: sql`greatest(coalesce(${tickets.lastRequesterMessageAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`,
      ...(REOPENS.includes(current.status) ? { status: 'in_progress' as const } : {}),
    })
    .where(eq(tickets.id, id));
  if (REOPENS.includes(current.status)) {
    await tx.insert(ticketEvents).values({
      ticketId: id,
      kind: 'status',
      fromStatus: current.status,
      toStatus: 'in_progress',
      at: now,
    });
  }
}

type FileRow = {
  name: string;
  contentType: string;
  size: number;
  storageKey: string | null;
  sha256: string | null;
  skippedReason: string | null;
};

/** Saves an email's attachments, or records why each refused one was not kept. */
async function downloadAttachments(ctx: PollContext, graphId: string): Promise<FileRow[]> {
  const base = `${ctx.client.mailboxPath}/messages/${encodeURIComponent(graphId)}/attachments`;
  const list = await ctx.client.request<{ value: GraphAttachment[] }>(
    'GET',
    `${base}?$select=id,name,contentType,size`,
    { headers: { Prefer: PREFER } },
  );
  const rows: FileRow[] = [];
  try {
    for (const [index, a] of list.value.entries()) {
      const name = cleanFileName(a.name);
      const contentType = (a.contentType ?? 'application/octet-stream').slice(0, 200);
      const size = a.size ?? 0;
      const skip = (skippedReason: string) =>
        rows.push({ name, contentType, size, storageKey: null, sha256: null, skippedReason });
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') {
        skip('Not kept: only files are kept, not attached emails or links.');
      } else if (index >= ATTACHMENTS_PER_MESSAGE) {
        skip(`Not kept: only the first ${ATTACHMENTS_PER_MESSAGE} attachments are kept.`);
      } else if (size > ATTACHMENT_MAX_BYTES) {
        skip('Not kept: larger than 25 MB.');
      } else if (isBlockedAttachment(name)) {
        skip('Not kept: this file type can run programs.');
      } else {
        const data = await ctx.client.request<Buffer>(
          'GET',
          `${base}/${encodeURIComponent(a.id)}/$value`,
          { binary: true },
        );
        if (data.length > ATTACHMENT_MAX_BYTES) {
          skip('Not kept: larger than 25 MB.');
          continue;
        }
        const saved = await ctx.store.save(data);
        rows.push({
          name,
          contentType,
          size: data.length,
          storageKey: saved.key,
          sha256: saved.sha256,
          skippedReason: null,
        });
      }
    }
  } catch (err) {
    await Promise.all(rows.map((r) => (r.storageKey ? ctx.store.remove(r.storageKey) : null)));
    throw err;
  }
  return rows;
}
