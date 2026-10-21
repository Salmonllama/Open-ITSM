import { z } from 'zod';

export const TOKEN_SCOPES = [
  'assets:read',
  'assets:write',
  'tickets:read',
  'tickets:write',
] as const;
export const tokenScopeSchema = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

/** Every scope can be issued; kept separate so a future scope can ship before it is issuable. */
export const ISSUABLE_SCOPES = TOKEN_SCOPES;

export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
/** The admin page flags tokens that expire within this many days. */
export const TOKEN_WARN_DAYS = 14;

export const serviceAccountNameSchema = z.string().trim().min(1, 'Enter a name').max(100);

export const apiTokenSchema = z.object({
  id: z.uuid(),
  /** The public part of the token (`oitsm_<publicId>_...`), safe to show. */
  publicId: z.string(),
  scopes: z.array(tokenScopeSchema),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const serviceAccountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  disabled: z.boolean(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  tokens: z.array(apiTokenSchema),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

export const createServiceAccountRequestSchema = z.object({
  name: serviceAccountNameSchema,
  description: z.string().trim().max(500).default(''),
});
export type CreateServiceAccountRequest = z.input<typeof createServiceAccountRequestSchema>;

export const updateServiceAccountRequestSchema = z
  .object({
    name: serviceAccountNameSchema.optional(),
    description: z.string().trim().max(500).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateServiceAccountRequest = z.infer<typeof updateServiceAccountRequestSchema>;

export const createTokenRequestSchema = z.object({
  scopes: z
    .array(z.enum(ISSUABLE_SCOPES))
    .min(1, 'Choose at least one scope')
    .transform((s) => [...new Set(s)]),
  expiresInDays: z
    .int()
    .min(1, 'A token must last at least 1 day')
    .max(TOKEN_MAX_DAYS, `A token can last at most ${TOKEN_MAX_DAYS} days`)
    .default(TOKEN_DEFAULT_DAYS),
});
export type CreateTokenRequest = z.input<typeof createTokenRequestSchema>;

/** Returned once, at creation; the secret cannot be read again. */
export const createdTokenSchema = z.object({
  token: z.string(),
  apiToken: apiTokenSchema,
});
export type CreatedToken = z.infer<typeof createdTokenSchema>;
