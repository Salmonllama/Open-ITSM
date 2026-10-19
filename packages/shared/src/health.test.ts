import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  it('accepts a healthy response', () => {
    const parsed = healthResponseSchema.parse({
      status: 'ok',
      version: '0.1.0',
      uptimeSeconds: 12,
      checks: { app: 'ok', database: 'ok', queue: 'ok' },
    });
    expect(parsed.status).toBe('ok');
  });

  it('rejects an unknown component status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'degraded',
      version: '0.1.0',
      uptimeSeconds: 0,
      checks: { app: 'ok', database: 'ok', queue: 'ok' },
    });
    expect(result.success).toBe(false);
  });
});
