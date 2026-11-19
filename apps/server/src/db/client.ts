import { readFileSync } from 'node:fs';
import path from 'node:path';
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

/**
 * True when this database has been migrated before and new migrations are waiting to run.
 * Fresh empty installs return false so they do not take an empty backup before first boot.
 */
export async function hasPendingMigrations(pool: pg.Pool): Promise<boolean> {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries?: unknown[] };
  const total = journal.entries?.length ?? 0;
  const check = await pool.query<{ reg: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations') as reg`,
  );
  if (!check.rows[0]?.reg) return false;
  const applied = await pool.query<{ n: number }>(
    `select count(*)::int as n from drizzle.__drizzle_migrations`,
  );
  const count = applied.rows[0]?.n ?? 0;
  return count > 0 && count < total;
}

export async function checkDatabase(pool: pg.Pool): Promise<boolean> {
  await pool.query('select 1');
  return true;
}
