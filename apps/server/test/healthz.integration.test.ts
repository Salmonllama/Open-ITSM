import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { buildApp } from '../src/app.js';
import { checkDatabase, createPool } from '../src/db.js';
import { checkQueue, createQueue } from '../src/queue.js';

// Runs against a real PostgreSQL when TEST_DATABASE_URL is set (CI always sets it).
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';

describe.skipIf(!databaseUrl)('GET /healthz against PostgreSQL', () => {
  let pool: pg.Pool;
  let queue: PgBoss;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    pool = createPool(databaseUrl);
    queue = createQueue(databaseUrl, pino({ level: 'silent' }));
    await queue.start();
    app = await buildApp({
      version: 'test',
      logger: false,
      checks: { database: () => checkDatabase(pool), queue: () => checkQueue(queue) },
    });
  });

  afterAll(async () => {
    await app?.close();
    await queue?.stop({ graceful: false });
    await pool?.end();
  });

  it('reports database and queue as ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ app: 'ok', database: 'ok', queue: 'ok' });
  });
});
