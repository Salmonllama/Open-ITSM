import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { healthResponseSchema } from '@open-itsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppOptions } from '../src/app.js';
import { makeApp as buildTestApp } from './helpers/app.js';

const ok = () => Promise.resolve(true);
let app: Awaited<ReturnType<typeof buildTestApp>> | undefined;

async function makeApp(overrides: Partial<AppOptions> = {}) {
  app = await buildTestApp(overrides);
  return app;
}

function makeWebRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'open-itsm-web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Open ITSM</title>');
  writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /healthz', () => {
  it('reports ok when every component is healthy', async () => {
    const res = await (await makeApp()).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = healthResponseSchema.parse(res.json());
    expect(body).toMatchObject({
      status: 'ok',
      version: '1.2.3',
      checks: { app: 'ok', database: 'ok', queue: 'ok' },
    });
  });

  it('returns 503 and names the failing component when the database is down', async () => {
    const res = await (
      await makeApp({ checks: { database: () => Promise.reject(new Error('down')), queue: ok } })
    ).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'error',
      checks: { app: 'ok', database: 'error', queue: 'ok' },
    });
  });

  it('treats a queue check that reports false as an error', async () => {
    const res = await (
      await makeApp({ checks: { database: ok, queue: () => Promise.resolve(false) } })
    ).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: { queue: 'error' } });
  });
});

describe('route access', () => {
  it('has every route declare who may call it', async () => {
    const instance = await makeApp({ webRoot: makeWebRoot() });
    await instance.ready();
    const undeclared = instance.declaredRoutes
      .filter((route) => !route.config?.access)
      .map((route) => `${String(route.method)} ${route.url}`);
    expect(undeclared).toEqual([]);
  });

  it('keeps the API reference behind sign-in', async () => {
    const instance = await makeApp();
    for (const url of ['/api/docs', '/api/docs/json', '/api/docs/static/index.html']) {
      const res = await instance.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('sends no CORS headers', async () => {
    const res = await (
      await makeApp()
    ).inject({
      method: 'OPTIONS',
      url: '/api/assets',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('web UI serving', () => {
  it('serves static files and falls back to index.html for client routes', async () => {
    const instance = await makeApp({ webRoot: makeWebRoot() });
    const asset = await instance.inject({ method: 'GET', url: '/app.js' });
    expect(asset.statusCode).toBe(200);

    const page = await instance.inject({
      method: 'GET',
      url: '/assets/LAP-000123',
      headers: { accept: 'text/html' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Open ITSM</title>');
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await (
      await makeApp({ webRoot: makeWebRoot() })
    ).inject({
      method: 'GET',
      url: '/api/nope',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'not_found',
      message: 'There is no API route at this address.',
    });
  });
});
