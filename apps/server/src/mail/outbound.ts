import { buffer } from 'node:stream/consumers';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AttachmentStore } from '../attachments.js';
import type { Db } from '../db/client.js';
import { requesters, ticketAttachments, ticketMessages, tickets } from '../db/schema.js';
import { GraphError, type GraphClient } from './graph.js';
import { outboundSubject } from './headers.js';
import { PREFER } from './inbound.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Graph takes attachments up to 3 MB in one request; larger ones go through an upload session. */
const INLINE_ATTACHMENT_MAX = 3 * 1024 * 1024;
/** Upload session chunks must be multiples of 320 KiB. */
const UPLOAD_CHUNK = 327_680 * 12;

export type SendContext = {
  db: Db;
  client: GraphClient;
  store: AttachmentStore;
  log: Logger;
};

export type SendOutcome = 'sent' | 'skipped' | 'failed' | 'retry';

type Draft = { id: string };

/**
 * Emails one reply to the requester with `[#N]` in the subject, as a reply to their latest
 * email when there is one so it threads in their mail app. The reply row is locked while it
 * sends, so two workers cannot send it twice. A temporary failure leaves it queued and throws,
 * so the job is retried; any other failure, or the last attempt, marks it failed with the reason.
 */
export async function sendReply(
  ctx: SendContext,
  messageId: number,
  options: { finalAttempt: boolean },
): Promise<SendOutcome> {
  let retryError: unknown;
  const outcome = await ctx.db.transaction(async (tx: Tx): Promise<SendOutcome> => {
    const [msg] = await tx
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.id, messageId))
      .for('update', { skipLocked: true });
    if (!msg || msg.kind !== 'reply') return 'skipped';
    if (msg.emailStatus !== 'queued' && msg.emailStatus !== 'failed') return 'skipped';

    try {
      const sent = await deliver(ctx, tx, msg);
      await tx
        .update(ticketMessages)
        .set({
          emailStatus: 'sent',
          emailError: null,
          emailedAt: new Date(),
          internetMessageId: sent.internetMessageId,
          conversationId: sent.conversationId,
        })
        .where(eq(ticketMessages.id, messageId));
      return 'sent';
    } catch (err) {
      const message =
        err instanceof GraphError ? err.message : 'The reply could not be emailed. Try again.';
      const transient = err instanceof GraphError && err.transient;
      if (!(err instanceof GraphError)) ctx.log.error({ err, messageId }, 'sending a reply failed');
      else
        ctx.log.warn({ messageId, status: err.status, code: err.code }, 'sending a reply failed');
      const retry = transient && !options.finalAttempt;
      await tx
        .update(ticketMessages)
        .set({
          emailStatus: retry ? 'queued' : 'failed',
          emailError: retry ? `${message} Trying again.` : message,
        })
        .where(eq(ticketMessages.id, messageId));
      if (retry) retryError = err;
      return retry ? 'retry' : 'failed';
    }
  });
  if (retryError) throw retryError;
  return outcome;
}

type MessageRow = typeof ticketMessages.$inferSelect;

async function deliver(ctx: SendContext, tx: Tx, msg: MessageRow) {
  const { client } = ctx;
  const [ticket] = await tx
    .select({
      number: tickets.number,
      subject: tickets.subject,
      email: requesters.email,
      name: requesters.name,
    })
    .from(tickets)
    .innerJoin(requesters, eq(requesters.id, tickets.requesterId))
    .where(eq(tickets.id, msg.ticketId));
  if (!ticket) throw new Error(`ticket ${msg.ticketId} vanished`);

  // Reply to the requester's latest email, so it threads; a ticket opened from the dashboard
  // has none, and gets a new email.
  const [latest] = await tx
    .select({ graphId: ticketMessages.graphMessageId })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.ticketId, msg.ticketId),
        eq(ticketMessages.kind, 'inbound'),
        isNotNull(ticketMessages.graphMessageId),
      ),
    )
    .orderBy(desc(ticketMessages.at), desc(ticketMessages.id))
    .limit(1);

  const files = await tx
    .select()
    .from(ticketAttachments)
    .where(and(eq(ticketAttachments.messageId, msg.id), isNotNull(ticketAttachments.storageKey)));

  const mbx = client.mailboxPath;
  const headers = { Prefer: PREFER };
  let draft: Draft;
  if (latest?.graphId) {
    try {
      draft = await client.request<Draft>(
        'POST',
        `${mbx}/messages/${encodeURIComponent(latest.graphId)}/createReply`,
        { body: {}, headers },
      );
    } catch (err) {
      // The requester's email was deleted from the mailbox: send a new email instead.
      if (!(err instanceof GraphError && err.status === 404)) throw err;
      draft = await client.request<Draft>('POST', `${mbx}/messages`, { body: {}, headers });
    }
  } else {
    draft = await client.request<Draft>('POST', `${mbx}/messages`, { body: {}, headers });
  }

  const draftPath = `${mbx}/messages/${encodeURIComponent(draft.id)}`;
  let sending = false;
  try {
    await client.request('PATCH', draftPath, {
      headers,
      body: {
        subject: outboundSubject(ticket.number, ticket.subject, latest?.graphId != null),
        body: { contentType: 'Text', content: msg.body },
        toRecipients: [{ emailAddress: { address: ticket.email, name: ticket.name || undefined } }],
        ccRecipients: [],
        bccRecipients: [],
      },
    });
    for (const file of files) {
      if (!file.storageKey) continue;
      const data = await buffer(ctx.store.read(file.storageKey));
      if (data.length <= INLINE_ATTACHMENT_MAX) {
        await client.request('POST', `${draftPath}/attachments`, {
          headers,
          body: {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: file.name,
            contentType: file.contentType,
            contentBytes: data.toString('base64'),
          },
        });
      } else {
        const session = await client.request<{ uploadUrl: string }>(
          'POST',
          `${draftPath}/attachments/createUploadSession`,
          {
            headers,
            body: {
              AttachmentItem: { attachmentType: 'file', name: file.name, size: data.length },
            },
          },
        );
        for (let start = 0; start < data.length; start += UPLOAD_CHUNK) {
          const chunk = data.subarray(start, Math.min(start + UPLOAD_CHUNK, data.length));
          await client.uploadChunk(session.uploadUrl, chunk, start, data.length);
        }
      }
    }
    const ids = await client.request<{ internetMessageId?: string; conversationId?: string }>(
      'GET',
      `${draftPath}?$select=internetMessageId,conversationId`,
      { headers },
    );
    sending = true;
    await client.request('POST', `${draftPath}/send`, { headers });
    return {
      internetMessageId: ids.internetMessageId ?? null,
      conversationId: ids.conversationId ?? null,
    };
  } catch (err) {
    // Leave no half-written draft in the shared mailbox. Once send was asked for, the message
    // may already be in Sent Items under the same ID, so it is left alone.
    if (!sending) await client.request('DELETE', draftPath, { headers }).catch(() => undefined);
    throw err;
  }
}

/** Replies waiting to be emailed, oldest first: sent again after a restart lost their job. */
export async function queuedReplies(db: Db, olderThan: Date): Promise<number[]> {
  const rows = await db
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(
      and(
        inArray(ticketMessages.emailStatus, ['queued']),
        sql`${ticketMessages.at} < ${olderThan.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(ticketMessages.at)
    .limit(100);
  return rows.map((r) => r.id);
}
