import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/client.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';

describe.skipIf(!testDatabaseUrl)('database rules', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('applies migrations idempotently', async () => {
    await runMigrations(t.db);
    const { rows } = await t.pool.query(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(rows[0].n).toBe(11);
  });

  it('enforces unique, normalized emails and valid roles', async () => {
    await t.pool.query(
      `insert into users (email, name, role) values ('a@example.com', 'A', 'admin')`,
    );
    await expect(
      t.pool.query(`insert into users (email, name, role) values ('a@example.com', 'B', 'admin')`),
    ).rejects.toThrow(/users_email_key/);
    await expect(
      t.pool.query(
        `insert into users (email, name, role) values ('Mixed@Example.com', 'C', 'admin')`,
      ),
    ).rejects.toThrow(/users_email_normalized/);
    await expect(
      t.pool.query(`insert into users (email, name, role) values ('d@example.com', 'D', 'owner')`),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('keeps the audit log append only', async () => {
    await t.pool.query(`insert into audit_log (action) values ('test.entry')`);
    await expect(t.pool.query(`update audit_log set action = 'changed'`)).rejects.toThrow(
      /append only/,
    );
    await expect(t.pool.query(`delete from audit_log`)).rejects.toThrow(/append only/);
    await expect(t.pool.query(`truncate audit_log`)).rejects.toThrow(/append only/);
  });
});
