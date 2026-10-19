import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

/** SQL migrations live beside src/ and dist/, so this resolves in dev and in the image. */
export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** Applies pending migrations in a single transaction; on failure nothing is changed. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export async function checkDatabase(pool: pg.Pool): Promise<boolean> {
  await pool.query('select 1');
  return true;
}
