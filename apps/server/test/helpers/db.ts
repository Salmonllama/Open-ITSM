import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, createPool, runMigrations, type Db } from '../../src/db/client.js';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';

export type TestDatabase = { db: Db; pool: pg.Pool; url: string; drop: () => Promise<void> };

/** Creates an isolated, migrated database so test files can run in parallel. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `itsm_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  const db = createDb(pool);
  await runMigrations(db);

  return {
    db,
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      const client = new pg.Client({ connectionString: testDatabaseUrl });
      await client.connect();
      await client.query(`drop database if exists ${name} with (force)`);
      await client.end();
    },
  };
}
