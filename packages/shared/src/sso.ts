import { z } from 'zod';

/** Warn this many days before the Entra ID client secret expires. */
export const SSO_SECRET_WARN_DAYS = 30;

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const domain = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const entraSettingsRequestSchema = z.object({
  /** The directory (tenant) ID, or a verified domain such as contoso.onmicrosoft.com. */
  tenantId: z
    .string()
    .trim()
    .refine((v) => guid.test(v) || domain.test(v), 'Enter the directory (tenant) ID'),
  /** The application (client) ID of the Entra ID app registration. */
  clientId: z.string().trim().regex(guid, 'Enter the application (client) ID'),
  /** Blank keeps the stored secret. Never returned by the API. */
  clientSecret: z.string().trim().max(512).default(''),
  /** Object ID of the Entra ID group whose members sign in as technicians. */
  technicianGroupId: z.string().trim().regex(guid, "Enter the technician group's object ID"),
  /** Optional expiry date for the client secret (YYYY-MM-DD), for advance warnings. */
  secretExpiresOn: z
    .union([z.literal(''), z.iso.date('Enter the date the client secret expires')])
    .nullable()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  /** Whether Microsoft sign-in is offered on the login page. Local accounts always stay on. */
  enabled: z.boolean().default(true),
});
export type EntraSettingsRequest = z.input<typeof entraSettingsRequestSchema>;

export const ENTRA_STATES = [
  'not_configured',
  'off',
  'connected',
  'failing',
  'secret_expiring',
  'secret_expired',
] as const;
export const entraStateSchema = z.enum(ENTRA_STATES);
export type EntraState = z.infer<typeof entraStateSchema>;

export const entraSettingsSchema = z.object({
  configured: z.boolean(),
  tenantId: z.string(),
  clientId: z.string(),
  technicianGroupId: z.string(),
  secretExpiresOn: z.iso.date().nullable(),
  /** A secret is stored. The secret itself is never returned. */
  secretSet: z.boolean(),
  enabled: z.boolean(),
  state: entraStateSchema,
  /** Callback URL to register in Entra ID, built from APP_HOSTNAME when set. */
  redirectUri: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
});
export type EntraSettings = z.infer<typeof entraSettingsSchema>;

export const entraTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type EntraTestResult = z.infer<typeof entraTestResultSchema>;

/** Sign-in options shown on the login page; public so signed-out visitors know what is available. */
export const authMethodsSchema = z.object({
  local: z.literal(true),
  entra: z.object({ enabled: z.boolean() }),
  emailLink: z.object({ enabled: z.boolean() }),
});
export type AuthMethods = z.infer<typeof authMethodsSchema>;
