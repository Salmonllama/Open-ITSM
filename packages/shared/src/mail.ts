import { z } from 'zod';
import { emailSchema } from './auth.js';

/** Warn this many days before the client secret expires: an expired secret stops intake. */
export const MAIL_SECRET_WARN_DAYS = 30;

/** Each attachment, in and out, is capped at this size. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** At most this many attachments on one message. */
export const ATTACHMENTS_PER_MESSAGE = 20;
/** Outbound attachments on one reply together stay under the mailbox's send limit. */
export const OUTBOUND_ATTACHMENTS_MAX_BYTES = 25 * 1024 * 1024;

/**
 * File types refused in and out because they run code when opened. Kept as a short list of
 * well-known extensions; everything is downloaded, never opened in the browser.
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS = [
  'app',
  'bat',
  'cmd',
  'com',
  'cpl',
  'dll',
  'exe',
  'hta',
  'jar',
  'js',
  'jse',
  'lnk',
  'msc',
  'msi',
  'msp',
  'pif',
  'ps1',
  'psm1',
  'reg',
  'scr',
  'vbe',
  'vbs',
  'wsf',
  'wsh',
] as const;

export function isBlockedAttachment(name: string): boolean {
  const ext = /\.([^.]+)$/.exec(name.trim().toLowerCase())?.[1];
  return ext !== undefined && (BLOCKED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext);
}

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const domain = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const mailSettingsRequestSchema = z.object({
  /** The directory (tenant) ID, or a verified domain such as contoso.onmicrosoft.com. */
  tenantId: z
    .string()
    .trim()
    .refine((v) => guid.test(v) || domain.test(v), 'Enter the directory (tenant) ID'),
  /** The application (client) ID of the app registration. */
  clientId: z.string().trim().regex(guid, 'Enter the application (client) ID'),
  /** Blank keeps the stored secret. Never returned by the API. */
  clientSecret: z.string().trim().max(512).default(''),
  /** When the client secret expires, from the app registration (YYYY-MM-DD). */
  secretExpiresOn: z.iso.date('Enter the date the client secret expires'),
  /** The shared mailbox that receives support email. */
  mailbox: emailSchema,
  /** Checking the mailbox and sending replies; off keeps the settings without using them. */
  enabled: z.boolean().default(true),
});
export type MailSettingsRequest = z.input<typeof mailSettingsRequestSchema>;

export const MAIL_STATES = [
  'not_configured',
  'off',
  'connected',
  'failing',
  'secret_expiring',
  'secret_expired',
] as const;
export const mailStateSchema = z.enum(MAIL_STATES);
export type MailState = z.infer<typeof mailStateSchema>;

/** What staff see about the mailbox, on the ticket list. */
export const mailStatusSchema = z.object({
  state: mailStateSchema,
  mailbox: z.string().nullable(),
  secretExpiresOn: z.iso.date().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  /** The last error while checking or sending, until a check succeeds. */
  lastError: z.string().nullable(),
});
export type MailStatus = z.infer<typeof mailStatusSchema>;

export const mailSettingsSchema = z.object({
  configured: z.boolean(),
  tenantId: z.string(),
  clientId: z.string(),
  mailbox: z.string(),
  secretExpiresOn: z.iso.date().nullable(),
  /** A secret is stored. The secret itself is never returned. */
  secretSet: z.boolean(),
  enabled: z.boolean(),
  /** Mail received before this moment is never turned into tickets. */
  connectedAt: z.iso.datetime().nullable(),
  status: mailStatusSchema,
  /** Tickets opened from email since the mailbox was connected. */
  ticketsFromEmail: z.int(),
});
export type MailSettings = z.infer<typeof mailSettingsSchema>;

export const mailTestResultSchema = z.object({
  ok: z.boolean(),
  /** Which step stopped: signing in to Microsoft, or opening the mailbox. */
  step: z.enum(['sign_in', 'mailbox']).nullable(),
  message: z.string(),
});
export type MailTestResult = z.infer<typeof mailTestResultSchema>;

/** Daily days until a date, from the start of today in UTC. */
export function daysUntil(date: string, now = new Date()): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}
