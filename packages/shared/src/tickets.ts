import { z } from 'zod';
import { actorSchema, assetStatusSchema } from './assets.js';
import { emailSchema } from './auth.js';

export const TICKET_STATUSES = [
  'new',
  'in_progress',
  'waiting_on_user',
  'resolved',
  'closed',
] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

/** Statuses a ticket still needs work in; Resolved and Closed are done. */
export const OPEN_TICKET_STATUSES = [
  'new',
  'in_progress',
  'waiting_on_user',
] as const satisfies TicketStatus[];

/** People set every status but New, which only a ticket nobody has touched has. */
export const SETTABLE_TICKET_STATUSES = [
  'in_progress',
  'waiting_on_user',
  'resolved',
  'closed',
] as const satisfies TicketStatus[];

export function isOpenTicketStatus(status: TicketStatus): boolean {
  return (OPEN_TICKET_STATUSES as readonly TicketStatus[]).includes(status);
}

/** Where a ticket came from: an email (M7), a technician's New ticket, or an API token. */
export const TICKET_SOURCES = ['email', 'dashboard', 'api'] as const;
export const ticketSourceSchema = z.enum(TICKET_SOURCES);
export type TicketSource = z.infer<typeof ticketSourceSchema>;

/** A requester's message, a reply to them (emailed from M7) or an internal note (never emailed). */
export const TICKET_MESSAGE_KINDS = ['inbound', 'reply', 'note'] as const;
export const ticketMessageKindSchema = z.enum(TICKET_MESSAGE_KINDS);
export type TicketMessageKind = z.infer<typeof ticketMessageKindSchema>;

export const TICKET_EVENT_KINDS = [
  'created',
  'status',
  'assignee',
  'asset_linked',
  'asset_unlinked',
] as const;
export const ticketEventKindSchema = z.enum(TICKET_EVENT_KINDS);
export type TicketEventKind = z.infer<typeof ticketEventKindSchema>;

export const TICKET_SUBJECT_MAX = 300;
export const TICKET_BODY_MAX = 50_000;

const subject = z
  .string()
  .trim()
  .min(1, 'Enter a subject')
  .max(TICKET_SUBJECT_MAX, `Keep the subject to ${TICKET_SUBJECT_MAX} characters`);
const body = z
  .string()
  .trim()
  .min(1, 'Write a message')
  .max(TICKET_BODY_MAX, `Keep the message to ${TICKET_BODY_MAX.toLocaleString('en')} characters`);

export const userRefSchema = z.object({ id: z.uuid(), name: z.string() });
export type UserRef = z.infer<typeof userRefSchema>;

/** Who sent a message: a name (may be blank) and an email. */
export const senderSchema = z.object({ name: z.string(), email: z.string() });
export type Sender = z.infer<typeof senderSchema>;

export const requesterSchema = senderSchema.extend({ id: z.uuid() });
export type Requester = z.infer<typeof requesterSchema>;

export const requesterQuerySchema = z.object({ q: z.string().trim().max(200).optional() });

/** Requesters matching a search, for suggestions in the New ticket form. */
export const requesterListSchema = z.array(requesterSchema);
export type RequesterList = z.infer<typeof requesterListSchema>;

export const linkedAssetSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  name: z.string(),
  status: assetStatusSchema,
  type: z.string(),
});
export type LinkedAsset = z.infer<typeof linkedAssetSchema>;

export const ticketSummarySchema = z.object({
  id: z.uuid(),
  number: z.int(),
  subject: z.string(),
  status: ticketStatusSchema,
  source: ticketSourceSchema,
  requester: requesterSchema,
  assignee: userRefSchema.nullable(),
  createdAt: z.iso.datetime(),
  /** The latest message or change, which the list sorts by. */
  lastActivityAt: z.iso.datetime(),
  /** The requester has written since you last opened it. Always false for a token. */
  unread: z.boolean(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

export const TICKET_QUEUES = ['open', 'unassigned', 'mine', 'waiting', 'closed'] as const;
export const ticketQueueSchema = z.enum(TICKET_QUEUES);
export type TicketQueue = z.infer<typeof ticketQueueSchema>;

export const TICKET_PAGE_SIZE = 25;

export const ticketListQuerySchema = z.object({
  /** Ticket number (with or without #), subject, requester or a linked asset's number. */
  q: z.string().trim().max(200).optional(),
  /**
   * open: New, In progress and Waiting on user; unassigned and mine: open ones; waiting: Waiting
   * on user; closed: Resolved and Closed. Mine is empty for a token, which is nobody.
   */
  queue: ticketQueueSchema.default('open'),
  status: ticketStatusSchema.optional(),
  /** `me`, `none` or a user's ID. */
  assignee: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
  source: ticketSourceSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(TICKET_PAGE_SIZE),
});
export type TicketListQuery = z.input<typeof ticketListQuerySchema>;

export const ticketCountsSchema = z.object({
  open: z.int(),
  unassigned: z.int(),
  mine: z.int(),
  waiting: z.int(),
  closed: z.int(),
});
export type TicketCounts = z.infer<typeof ticketCountsSchema>;

export const ticketListResponseSchema = z.object({
  items: z.array(ticketSummarySchema),
  total: z.int(),
  page: z.int(),
  pageSize: z.int(),
  /** Tickets in each queue matching the search, whatever the queue and filters. */
  counts: ticketCountsSchema,
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

/** How a reply went out: not at all (no mailbox then), waiting to send, sent, or failed. */
export const EMAIL_STATUSES = ['not_sent', 'queued', 'sent', 'failed'] as const;
export const emailStatusSchema = z.enum(EMAIL_STATUSES);
export type EmailStatus = z.infer<typeof emailStatusSchema>;

export const ticketAttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  contentType: z.string(),
  size: z.int(),
  /** Why an emailed attachment was not kept (too large, a blocked file type); null if kept. */
  skippedReason: z.string().nullable(),
});
export type TicketAttachment = z.infer<typeof ticketAttachmentSchema>;

export const ticketMessageSchema = z.object({
  id: z.int(),
  kind: ticketMessageKindSchema,
  body: z.string(),
  at: z.iso.datetime(),
  /** The staff member or service account who wrote a reply or note, or who entered a message. */
  by: actorSchema.nullable(),
  /** For a requester's message: who sent it. */
  from: senderSchema.nullable(),
  /** For a reply: when it was emailed, or null if it was not (no mailbox connected yet). */
  emailedAt: z.iso.datetime().nullable(),
  /** For a reply: whether it went out by email. Null for requester messages and notes. */
  emailStatus: emailStatusSchema.nullable(),
  /** Why the last attempt to email a reply failed. */
  emailError: z.string().nullable(),
  attachments: z.array(ticketAttachmentSchema),
});
export type TicketMessage = z.infer<typeof ticketMessageSchema>;

export const ticketEventSchema = z.object({
  id: z.int(),
  kind: ticketEventKindSchema,
  fromStatus: ticketStatusSchema.nullable(),
  toStatus: ticketStatusSchema.nullable(),
  fromAssignee: userRefSchema.nullable(),
  toAssignee: userRefSchema.nullable(),
  /** For a linked or unlinked asset; `id` is null if the asset has since been deleted. */
  asset: z.object({ id: z.uuid().nullable(), number: z.string() }).nullable(),
  at: z.iso.datetime(),
  by: actorSchema.nullable(),
});
export type TicketEvent = z.infer<typeof ticketEventSchema>;

export const ticketDetailSchema = ticketSummarySchema.extend({
  /** Oldest first, as a conversation reads. */
  messages: z.array(ticketMessageSchema),
  /** Newest first. */
  events: z.array(ticketEventSchema),
  firstResponseAt: z.iso.datetime().nullable(),
  lastRequesterMessageAt: z.iso.datetime().nullable(),
  /** The requester's other open tickets. */
  requesterOpenTickets: z.int(),
  linkedAssets: z.array(linkedAssetSchema),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const createTicketRequestSchema = z.object({
  subject,
  requester: z.object({
    name: z.string().trim().max(200).default(''),
    email: emailSchema,
  }),
  /** What the requester asked, entered as their first message. */
  message: body,
  /** Assets the ticket is about. */
  assetIds: z.array(z.uuid()).max(20).default([]),
});
export type CreateTicketRequest = z.input<typeof createTicketRequestSchema>;

export const updateTicketRequestSchema = z
  .object({
    status: z.enum(SETTABLE_TICKET_STATUSES).optional(),
    /** A staff member's ID, or null to unassign. */
    assigneeId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assigneeId !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateTicketRequest = z.input<typeof updateTicketRequestSchema>;

export const addTicketMessageRequestSchema = z
  .object({
    kind: z.enum(['reply', 'note']),
    body: z
      .string()
      .trim()
      .max(
        TICKET_BODY_MAX,
        `Keep the message to ${TICKET_BODY_MAX.toLocaleString('en')} characters`,
      ),
    /** Set a status in the same step, as "Send and set Waiting on user" does. */
    status: z.enum(SETTABLE_TICKET_STATUSES).optional(),
    /** Files uploaded to this ticket with `POST /api/tickets/:id/attachments`. */
    attachmentIds: z.array(z.uuid()).max(20).default([]),
  })
  .refine((v) => v.body !== '' || v.attachmentIds.length > 0, {
    message: 'Write a message or attach a file',
    path: ['body'],
  });
export type AddTicketMessageRequest = z.input<typeof addTicketMessageRequestSchema>;

export const linkTicketAssetRequestSchema = z.object({ assetId: z.uuid() });

/** Staff a ticket can be assigned to: active administrators and technicians. */
export const ticketAssigneeListSchema = z.array(userRefSchema);
export type TicketAssigneeList = z.infer<typeof ticketAssigneeListSchema>;
