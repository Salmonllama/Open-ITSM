import {
  emailLinkRedeemRequestSchema,
  emailLinkRequestSchema,
  emailLinkResponseSchema,
  errorResponseSchema,
  isOpenTicketStatus,
  OPEN_TICKET_STATUSES,
  portalReplyRequestSchema,
  portalSettingsRequestSchema,
  portalSettingsSchema,
  portalTicketDetailSchema,
  portalTicketListResponseSchema,
  sessionResponseSchema,
  type PortalTicketDetail,
  type TicketAttachment,
} from '@open-itsm/shared';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { attachmentDisposition } from '../attachments.js';
import { audit } from '../audit.js';
import { actorOf, PUBLIC, setSessionCookie } from '../auth/http.js';
import type { Db } from '../db/client.js';
import {
  requesters,
  ticketAttachments,
  ticketEvents,
  ticketMessages,
  tickets,
  users,
} from '../db/schema.js';
import {
  InvalidLoginLinkError,
  MailNotConnectedError,
  PortalDisabledError,
} from '../portal/service.js';
import { ADMIN_ONLY, AUTH_RATE_LIMIT, END_USER_ONLY, type RouteDeps } from './deps.js';

type Executor = Pick<Db, 'select'>;

const idParams = z.object({ id: z.uuid() });
const fileParams = z.object({ id: z.uuid(), attachmentId: z.uuid() });

const OPEN = [...OPEN_TICKET_STATUSES];

const PORTAL_OFF = {
  error: 'portal_disabled',
  message: 'The end-user portal is switched off.',
} as const;

const TICKET_NOT_FOUND = {
  error: 'not_found',
  message: 'That ticket was not found.',
} as const;

const LINK_SENT = {
  message:
    'If an email address can use the portal, a one-time sign-in link has been sent. It expires in 15 minutes.',
} as const;

function originOf(request: FastifyRequest, siteUrl: string | null): string {
  return siteUrl ?? `${request.protocol}://${request.host}`;
}

/**
 * Loads one ticket ONLY when the requester's email matches the signed-in end user's email,
 * excluding internal technician notes (`kind = 'note'`) in SQL.
 */
async function loadPortalTicket(
  db: Executor,
  ticketId: string,
  userEmail: string,
): Promise<PortalTicketDetail | undefined> {
  const [found] = await db
    .select({
      id: tickets.id,
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      createdAt: tickets.createdAt,
      lastActivityAt: tickets.lastActivityAt,
    })
    .from(tickets)
    .innerJoin(requesters, eq(requesters.id, tickets.requesterId))
    .where(and(eq(tickets.id, ticketId), eq(requesters.email, userEmail)));
  if (!found) return undefined;

  const messages = await db
    .select({
      id: ticketMessages.id,
      kind: ticketMessages.kind,
      body: ticketMessages.body,
      at: ticketMessages.at,
      fromName: ticketMessages.fromName,
      fromEmail: ticketMessages.fromEmail,
      actorName: users.name,
    })
    .from(ticketMessages)
    .leftJoin(users, eq(users.id, ticketMessages.actorUserId))
    .where(and(eq(ticketMessages.ticketId, found.id), ne(ticketMessages.kind, 'note')))
    .orderBy(asc(ticketMessages.at), asc(ticketMessages.id));

  const messageIds = messages.map((m) => m.id);
  const files =
    messageIds.length === 0
      ? []
      : await db
          .select({
            id: ticketAttachments.id,
            messageId: ticketAttachments.messageId,
            name: ticketAttachments.name,
            contentType: ticketAttachments.contentType,
            size: ticketAttachments.size,
            skippedReason: ticketAttachments.skippedReason,
          })
          .from(ticketAttachments)
          .where(
            and(
              eq(ticketAttachments.ticketId, found.id),
              inArray(ticketAttachments.messageId, messageIds),
            ),
          )
          .orderBy(asc(ticketAttachments.createdAt));

  const filesByMessage = new Map<number, TicketAttachment[]>();
  for (const f of files) {
    if (f.messageId === null) continue;
    const list = filesByMessage.get(f.messageId) ?? [];
    list.push({
      id: f.id,
      name: f.name,
      contentType: f.contentType,
      size: f.size,
      skippedReason: f.skippedReason,
    });
    filesByMessage.set(f.messageId, list);
  }

  return {
    id: found.id,
    number: found.number,
    subject: found.subject,
    status: found.status,
    createdAt: found.createdAt.toISOString(),
    lastActivityAt: found.lastActivityAt.toISOString(),
    messages: messages
      .filter((m): m is typeof m & { kind: 'inbound' | 'reply' } => m.kind !== 'note')
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        body: m.body,
        at: m.at.toISOString(),
        fromName:
          m.kind === 'inbound'
            ? m.fromName?.trim() || m.fromEmail || 'You'
            : m.actorName?.trim() || 'IT support',
        attachments: filesByMessage.get(m.id) ?? [],
      })),
  };
}

export function registerPortalRoutes(
  app: FastifyInstance,
  { db, sessions, portal, attachments }: RouteDeps,
) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/settings/portal',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Optional end-user portal settings',
        tags: ['settings'],
        response: { 200: portalSettingsSchema },
      },
    },
    async () => portal.settings(),
  );

  r.put(
    '/api/settings/portal',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Switch the optional end-user portal on or off',
        tags: ['settings'],
        body: portalSettingsRequestSchema,
        response: { 200: portalSettingsSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await portal.save(request.body.enabled, actor.actorUserId ?? '');
      await audit(db, {
        action: 'settings.portal_updated',
        ...actor,
        ip: request.ip,
        details: { enabled: request.body.enabled },
      });
      return portal.settings();
    },
  );

  r.post(
    '/api/auth/email-link',
    {
      config: { access: PUBLIC, csrf: 'origin-only', rateLimit: AUTH_RATE_LIMIT },
      schema: {
        summary: 'Email a one-time sign-in link to an end-user requester',
        tags: ['auth'],
        body: emailLinkRequestSchema,
        response: {
          200: emailLinkResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await portal.requestEmailLink(
          request.body.email,
          originOf(request, portal.siteUrl),
          request.ip,
        );
        return LINK_SENT;
      } catch (err) {
        if (err instanceof PortalDisabledError) return reply.code(403).send(PORTAL_OFF);
        if (err instanceof MailNotConnectedError) {
          return reply.code(409).send({
            error: 'mail_not_connected',
            message:
              'Email sign-in links are not available because no Microsoft 365 mailbox is connected.',
          });
        }
        throw err;
      }
    },
  );

  r.post(
    '/api/auth/email-link/redeem',
    {
      config: { access: PUBLIC, csrf: 'origin-only', rateLimit: AUTH_RATE_LIMIT },
      schema: {
        summary: 'Redeem a one-time emailed sign-in link and start an end-user session',
        tags: ['auth'],
        body: emailLinkRedeemRequestSchema,
        response: {
          200: sessionResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await portal.redeemEmailLink(request.body.token, sessions, {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        setSessionCookie(reply, result.session.token, result.session.expiresAt);
        return { user: result.user, csrfToken: result.session.csrfToken };
      } catch (err) {
        if (err instanceof PortalDisabledError) return reply.code(403).send(PORTAL_OFF);
        if (err instanceof InvalidLoginLinkError) {
          return reply.code(401).send({
            error: 'invalid_link',
            message: 'This sign-in link has expired or was already used. Request a new link.',
          });
        }
        throw err;
      }
    },
  );

  r.get(
    '/api/portal/tickets',
    {
      config: { access: END_USER_ONLY },
      schema: {
        summary: "List the signed-in end user's own open tickets",
        tags: ['portal'],
        response: { 200: portalTicketListResponseSchema, 403: errorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!(await portal.isEnabled())) return reply.code(403).send(PORTAL_OFF);
      const email = request.session?.user.email;
      if (!email) return reply.code(403).send(PORTAL_OFF);

      const rows = await db
        .select({
          id: tickets.id,
          number: tickets.number,
          subject: tickets.subject,
          status: tickets.status,
          createdAt: tickets.createdAt,
          lastActivityAt: tickets.lastActivityAt,
        })
        .from(tickets)
        .innerJoin(requesters, eq(requesters.id, tickets.requesterId))
        .where(and(eq(requesters.email, email), inArray(tickets.status, OPEN)))
        .orderBy(desc(tickets.lastActivityAt), desc(tickets.number));

      return {
        items: rows.map((row) => ({
          id: row.id,
          number: row.number,
          subject: row.subject,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          lastActivityAt: row.lastActivityAt.toISOString(),
        })),
      };
    },
  );

  r.get(
    '/api/portal/tickets/:id',
    {
      config: { access: END_USER_ONLY },
      schema: {
        summary: "Read one of the signed-in end user's own tickets",
        tags: ['portal'],
        params: idParams,
        response: {
          200: portalTicketDetailSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await portal.isEnabled())) return reply.code(403).send(PORTAL_OFF);
      const email = request.session?.user.email;
      if (!email) return reply.code(403).send(PORTAL_OFF);

      const ticket = await loadPortalTicket(db, request.params.id, email);
      if (!ticket) return reply.code(404).send(TICKET_NOT_FOUND);
      return ticket;
    },
  );

  r.post(
    '/api/portal/tickets/:id/messages',
    {
      config: { access: END_USER_ONLY },
      schema: {
        summary: "Reply to one of the signed-in end user's own open tickets",
        tags: ['portal'],
        params: idParams,
        body: portalReplyRequestSchema,
        response: {
          201: portalTicketDetailSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await portal.isEnabled())) return reply.code(403).send(PORTAL_OFF);
      const user = request.session?.user;
      if (!user) return reply.code(403).send(PORTAL_OFF);

      const outcome = await db.transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: tickets.id, status: tickets.status })
          .from(tickets)
          .innerJoin(requesters, eq(requesters.id, tickets.requesterId))
          .where(and(eq(tickets.id, request.params.id), eq(requesters.email, user.email)))
          .for('update', { of: tickets });
        if (!owned) return 'not_found' as const;
        if (!isOpenTicketStatus(owned.status)) return 'closed' as const;

        const now = new Date();
        await tx.insert(ticketMessages).values({
          ticketId: owned.id,
          kind: 'inbound',
          body: request.body.body,
          fromName: user.name,
          fromEmail: user.email,
          actorUserId: user.id,
          at: now,
        });

        const nextStatus = owned.status === 'waiting_on_user' ? 'in_progress' : owned.status;
        await tx
          .update(tickets)
          .set({
            status: nextStatus,
            lastActivityAt: now,
            lastRequesterMessageAt: now,
          })
          .where(eq(tickets.id, owned.id));

        if (nextStatus !== owned.status) {
          await tx.insert(ticketEvents).values({
            ticketId: owned.id,
            kind: 'status',
            fromStatus: owned.status,
            toStatus: nextStatus,
            at: now,
            actorUserId: user.id,
          });
        }
        return loadPortalTicket(tx, owned.id, user.email);
      });

      if (outcome === 'not_found') return reply.code(404).send(TICKET_NOT_FOUND);
      if (outcome === 'closed') {
        return reply.code(409).send({
          error: 'ticket_closed',
          message: 'This ticket is closed, so you cannot add a reply here.',
        });
      }
      if (!outcome) return reply.code(404).send(TICKET_NOT_FOUND);
      return reply.code(201).send(outcome);
    },
  );

  r.get(
    '/api/portal/tickets/:id/attachments/:attachmentId',
    {
      config: { access: END_USER_ONLY },
      schema: {
        summary: "Download a file on one of the signed-in end user's own tickets",
        tags: ['portal'],
        params: fileParams,
        response: {
          200: z.any().describe('The file'),
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await portal.isEnabled())) return reply.code(403).send(PORTAL_OFF);
      const email = request.session?.user.email;
      if (!email) return reply.code(403).send(PORTAL_OFF);

      const { id, attachmentId } = request.params;
      const [file] = await db
        .select({
          name: ticketAttachments.name,
          contentType: ticketAttachments.contentType,
          size: ticketAttachments.size,
          storageKey: ticketAttachments.storageKey,
        })
        .from(ticketAttachments)
        .innerJoin(ticketMessages, eq(ticketMessages.id, ticketAttachments.messageId))
        .innerJoin(tickets, eq(tickets.id, ticketAttachments.ticketId))
        .innerJoin(requesters, eq(requesters.id, tickets.requesterId))
        .where(
          and(
            eq(ticketAttachments.id, attachmentId),
            eq(ticketAttachments.ticketId, id),
            eq(requesters.email, email),
            ne(ticketMessages.kind, 'note'),
          ),
        );
      if (!file?.storageKey) return reply.code(404).send(TICKET_NOT_FOUND);

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
}
