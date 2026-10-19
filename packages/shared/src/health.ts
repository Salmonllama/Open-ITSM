import { z } from 'zod';

export const componentStatusSchema = z.enum(['ok', 'error']);
export type ComponentStatus = z.infer<typeof componentStatusSchema>;

export const healthResponseSchema = z.object({
  status: componentStatusSchema,
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    app: componentStatusSchema,
    database: componentStatusSchema,
    queue: componentStatusSchema,
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
