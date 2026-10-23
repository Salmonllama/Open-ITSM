import {
  ATTACHMENT_MAX_BYTES,
  errorResponseSchema,
  isBlockedAttachment,
  ticketAttachmentSchema,
} from '@open-itsm/shared';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { z } from 'zod';
import { attachmentDisposition, cleanFileName, type AttachmentStore } from '../attachments.js';
import { actorOf } from '../auth/http.js';
import type { Db } from '../db/client.js';
import { ticketAttachments, tickets } from '../db/schema.js';
import { TICKETS_READ, TICKETS_WRITE, type RouteDeps } from './deps.js';

const fileParams = z.object({ id: z.uuid(), attachmentId: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That file is not on this ticket. Reload the page.',
} as const;

/** A plain `type/subtype`, or a generic one; the browser is never told to render it anyway. */
function contentTypeOf(header: string | undefined): string {
  const type = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(type)
    ? type
    : 'application/octet-stream';
}

export function registerTicketAttachmentRoutes(
  app: FastifyInstance,
  { db, attachments }: RouteDeps,
) {
  // Uploads send the file itself as the body, whatever its type; only these routes accept that.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    const r = scope.withTypeProvider<ZodTypeProvider>();
    r.post(
      '/api/tickets/:id/attachments',
      {
        config: { access: TICKETS_WRITE },
        schema: {
          summary: 'Upload a file to attach to the next reply or note',
          description:
            'Send the file as the request body with its own Content-Type, and its name in `name`. At most 25 MB; programs and scripts (such as .exe, .js, .ps1) are refused. The file waits until a message names it in `attachmentIds`; one not used within a day is removed.',
          tags: ['tickets'],
          params: z.object({ id: z.uuid() }),
          querystring: z.object({ name: z.string().trim().min(1).max(255) }),
          response: {
            201: ticketAttachmentSchema,
            400: errorResponseSchema,
            404: errorResponseSchema,
            415: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params;
        const data = request.body;
        if (!Buffer.isBuffer(data) || data.length === 0) {
          return reply.code(400).send({
            error: 'empty_file',
            message: 'The file is empty. Choose another file.',
          });
        }
        const name = cleanFileName(request.query.name);
        if (isBlockedAttachment(name)) {
          return reply.code(415).send({
            error: 'blocked_file_type',
            message:
              'Programs and scripts cannot be attached. Put the file in a .zip, or share a link.',
          });
        }
        const [ticket] = await db
          .select({ id: tickets.id })
          .from(tickets)
          .where(eq(tickets.id, id));
        if (!ticket) {
          return reply.code(404).send({
            error: 'not_found',
            message: 'That ticket no longer exists. Reload the page.',
          });
        }
        const saved = await attachments.save(data);
        try {
          const [row] = await db
            .insert(ticketAttachments)
            .values({
              ticketId: id,
              name,
              contentType: contentTypeOf(request.headers['content-type']),
              size: data.length,
              storageKey: saved.key,
              sha256: saved.sha256,
              ...actorOf(request),
            })
            .returning();
          if (!row) throw new Error('attachment insert returned nothing');
          return reply.code(201).send({
            id: row.id,
            name: row.name,
            contentType: row.contentType,
            size: row.size,
            skippedReason: null,
          });
        } catch (err) {
          await attachments.remove(saved.key);
          throw err;
        }
      },
    );
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/tickets/:id/attachments/:attachmentId',
    {
      config: { access: TICKETS_READ },
      schema: {
        summary: 'Download a file attached to a ticket message',
        description: 'Always sent as a download, never shown in the browser.',
        tags: ['tickets'],
        params: fileParams,
        response: { 200: z.any().describe('The file'), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, attachmentId } = request.params;
      const [file] = await db
        .select()
        .from(ticketAttachments)
        .where(and(eq(ticketAttachments.id, attachmentId), eq(ticketAttachments.ticketId, id)));
      if (!file?.storageKey) return reply.code(404).send(NOT_FOUND);
      // Files come from strangers: never let the browser render or sniff them.
      return reply
        .header('content-type', file.contentType)
        .header('content-length', String(file.size))
        .header('content-disposition', attachmentDisposition(file.name))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('cache-control', 'private, no-store')
        .send(attachments.read(file.storageKey));
    },
  );

  r.delete(
    '/api/tickets/:id/attachments/:attachmentId',
    {
      config: { access: TICKETS_WRITE },
      schema: {
        summary: 'Remove an uploaded file before it is sent',
        description: 'Only a file no message uses yet can be removed.',
        tags: ['tickets'],
        params: fileParams,
        response: { 204: z.null(), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, attachmentId } = request.params;
      const [removed] = await db
        .delete(ticketAttachments)
        .where(
          and(
            eq(ticketAttachments.id, attachmentId),
            eq(ticketAttachments.ticketId, id),
            isNull(ticketAttachments.messageId),
          ),
        )
        .returning({ storageKey: ticketAttachments.storageKey });
      if (!removed) return reply.code(404).send(NOT_FOUND);
      if (removed.storageKey) await attachments.remove(removed.storageKey);
      return reply.code(204).send(null);
    },
  );
}

/** Removes uploads that no message used within a day. */
export async function removeAbandonedUploads(
  db: Db,
  store: AttachmentStore,
  log: Logger,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const removed = await db
    .delete(ticketAttachments)
    .where(and(isNull(ticketAttachments.messageId), lt(ticketAttachments.createdAt, cutoff)))
    .returning({ storageKey: ticketAttachments.storageKey });
  for (const { storageKey } of removed) if (storageKey) await store.remove(storageKey);
  if (removed.length > 0) log.info({ removed: removed.length }, 'removed unused uploads');
  return removed.length;
}
