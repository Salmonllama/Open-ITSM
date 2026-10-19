import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const roleSchema = z.enum(['admin', 'technician', 'end_user']);
export type Role = z.infer<typeof roleSchema>;

/** Roles a local (password) account can have. End users sign in through Entra ID or email links. */
export const localRoleSchema = z.enum(['admin', 'technician']);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }).max(254));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const nameSchema = z.string().trim().min(1, 'Enter a name').max(200);

export const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
});
export type User = z.infer<typeof userSchema>;

export const adminUserSchema = userSchema.extend({
  disabled: z.boolean(),
  hasPassword: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const sessionResponseSchema = z.object({
  user: userSchema,
  csrfToken: z.string(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const setupStatusSchema = z.object({ required: z.boolean() });
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const setupRequestSchema = z.object({
  token: z.string().trim().min(1, 'Enter the setup token').max(200),
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Not passwordSchema: a login must not reveal the policy or reject old passwords early.
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const createUserRequestSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  role: localRoleSchema,
  password: passwordSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    name: nameSchema.optional(),
    role: localRoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const setPasswordRequestSchema = z.object({ password: passwordSchema });
export type SetPasswordRequest = z.infer<typeof setPasswordRequestSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
