import { describe, expect, it } from 'vitest';
import { fetchHealth } from './api';

const body = {
  status: 'error',
  version: '0.1.0',
  uptimeSeconds: 5,
  checks: { app: 'ok', database: 'error', queue: 'ok' },
};

const respond = (status: number, json: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(json), { status }));

describe('fetchHealth', () => {
  it('parses a 503 body so the UI can show which component is down', async () => {
    const health = await fetchHealth(respond(503, body));
    expect(health.checks.database).toBe('error');
  });

  it('throws on other HTTP errors', async () => {
    await expect(fetchHealth(respond(502, {}))).rejects.toThrow('HTTP 502');
  });
});
