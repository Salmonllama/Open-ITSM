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

describe('apiRequest', () => {
  it('sends the CSRF token on writes but not reads, and surfaces server messages', async () => {
    const { apiRequest, setCsrfToken, ApiError } = await import('./api');
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ error: 'locked', message: 'Try later' }), {
        status: 429,
      });
    }) as typeof fetch;

    setCsrfToken('tok');
    await expect(apiRequest('GET', '/api/x', { fetchImpl })).rejects.toBeInstanceOf(ApiError);
    await expect(apiRequest('POST', '/api/x', { body: {}, fetchImpl })).rejects.toThrow(
      'Try later',
    );
    expect(seen[0]?.['x-csrf-token']).toBeUndefined();
    expect(seen[1]?.['x-csrf-token']).toBe('tok');
  });
});
