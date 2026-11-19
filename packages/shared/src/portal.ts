import { z } from 'zod';
import { emailSchema } from './auth.js';
import { TICKET_BODY_MAX, ticketAttachmentSchema, ticketStatusSchema } from './tickets.js';

export const portalSettingsRequestSchema = z.object({
  /** Whether the optional end-user portal is on. Off by default. */
  enabled: z.boolean(),
});
export type PortalSettingsRequest = z.input<typeof portalSettingsRequestSchema>;

export const portalSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Whether Entra ID SSO is currently on (lets end users sign in with Microsoft). */
  entraEnabled: z.boolean(),
  /** Whether the Microsoft 365 mailbox is connected (lets end users sign in by email link). */
  mailConnected: z.boolean(),
});
export type PortalSettings = z.infer<typeof portalSettingsSchema>;

export const emailLinkRequestSchema = z.object({
  email: emailSchema,
});
export type EmailLinkRequest = z.input<typeof emailLinkRequestSchema>;

export const emailLinkResponseSchema = z.object({
  message: z.string(),
});
export type EmailLinkResponse = z.infer<typeof emailLinkResponseSchema>;

export const emailLinkRedeemRequestSchema = z.object({
  token: z.string().trim().min(16, 'This sign-in link is not valid').max(256),
});
export type EmailLinkRedeemRequest = z.input<typeof emailLinkRedeemRequestSchema>;

export const portalTicketSummarySchema = z.object({
  id: z.uuid(),
  number: z.int(),
  subject: z.string(),
  status: ticketStatusSchema,
  createdAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
});
export type PortalTicketSummary = z.infer<typeof portalTicketSummarySchema>;

export const portalTicketListResponseSchema = z.object({
  items: z.array(portalTicketSummarySchema),
});
export type PortalTicketListResponse = z.infer<typeof portalTicketListResponseSchema>;

/** End users only see their own messages and replies to them, never internal notes. */
export const portalTicketMessageSchema = z.object({
  id: z.int(),
  kind: z.enum(['inbound', 'reply']),
  body: z.string(),
  at: z.iso.datetime(),
  fromName: z.string(),
  attachments: z.array(ticketAttachmentSchema),
});
export type PortalTicketMessage = z.infer<typeof portalTicketMessageSchema>;

export const portalTicketDetailSchema = portalTicketSummarySchema.extend({
  messages: z.array(portalTicketMessageSchema),
});
export type PortalTicketDetail = z.infer<typeof portalTicketDetailSchema>;

export const portalReplyRequestSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a message')
    .max(TICKET_BODY_MAX, `Keep the message to ${TICKET_BODY_MAX.toLocaleString('en')} characters`),
});
export type PortalReplyRequest = z.input<typeof portalReplyRequestSchema>;
