import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../src/attachments.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../src/auth/http.js';
import { restoreBackupArchive } from '../src/backups/service.js';
import { createDb, createPool } from '../src/db/client.js';
import { makeApp, makeBackups, sessionCookie, TEST_SETUP_TOKEN } from './helpers/app.js';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from './helpers/db.js';

function hasPgDump(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    execFileSync('pg_restore', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!testDatabaseUrl || !hasPgDump())('Backup and restore (M11)', () => {
  let sourceDb: TestDatabase;
  let sourceAttachmentsDir: string;
  let sourceBackupsDir: string;

  beforeAll(async () => {
    sourceDb = await createTestDatabase();
    sourceAttachmentsDir = mkdtempSync(path.join(tmpdir(), 'open-itsm-src-att-'));
    sourceBackupsDir = mkdtempSync(path.join(tmpdir(), 'open-itsm-src-bak-'));
  });

  afterAll(async () => {
    await sourceDb.drop();
    rmSync(sourceAttachmentsDir, { recursive: true, force: true });
    rmSync(sourceBackupsDir, { recursive: true, force: true });
  });

  it('acceptance: takes a backup (database + attachments) and restores it into a fresh install', async () => {
    const store = new AttachmentStore(sourceAttachmentsDir);
    const backups = makeBackups(sourceDb.db, {
      databaseUrl: sourceDb.url,
      attachmentsDir: sourceAttachmentsDir,
      backupsDir: sourceBackupsDir,
      retentionDays: 14,
    });
    const app = await makeApp({ db: sourceDb.db, attachments: store, backups });

    try {
      // First-run setup creates admin.
      const setup = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: {
          token: TEST_SETUP_TOKEN,
          name: 'Backup Admin',
          email: 'admin@example.com',
          password: 'correct-horse-battery-staple',
        },
      });
      expect(setup.statusCode).toBe(201);
      const cookie = sessionCookie(setup);
      const csrf = setup.json().csrfToken;

      // Seed an asset type, an asset, a ticket, and a real attachment file.
      const typeRes = await app.inject({
        method: 'POST',
        url: '/api/asset-types',
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
        payload: { name: 'Laptop', prefix: 'LAP' },
      });
      expect(typeRes.statusCode).toBe(201);
      const assetRes = await app.inject({
        method: 'POST',
        url: '/api/assets',
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
        payload: {
          typeId: typeRes.json().id,
          name: 'ThinkPad X1 Carbon',
          status: 'in_stock',
        },
      });
      expect(assetRes.statusCode).toBe(201);
      const assetNumber = assetRes.json().number as string;

      const ticketRes = await app.inject({
        method: 'POST',
        url: '/api/tickets',
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
        payload: {
          subject: 'Docking station flickers',
          requester: { email: 'maya@example.com', name: 'Maya' },
          message: 'My second monitor blinks every few minutes.',
        },
      });
      expect(ticketRes.statusCode).toBe(201);
      const ticketId = ticketRes.json().id as string;

      const payloadBytes = Buffer.from('diagnostic-log-line-1\ndiagnostic-log-line-2\n');
      const uploadRes = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/attachments?name=diag.txt`,
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf, 'content-type': 'text/plain' },
        payload: payloadBytes,
      });
      expect(uploadRes.statusCode).toBe(201);
      const attachmentId = uploadRes.json().id as string;

      const msgRes = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/messages`,
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
        payload: { kind: 'note', body: 'Attached log.', attachmentIds: [attachmentId] },
      });
      expect(msgRes.statusCode).toBe(200);

      // Technicians and API tokens cannot touch /api/backups.
      const saRes = await app.inject({
        method: 'POST',
        url: '/api/service-accounts',
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
        payload: { name: 'Backup test script' },
      });
      const tokRes = await app.inject({
        method: 'POST',
        url: `/api/service-accounts/${saRes.json().id}/tokens`,
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
        payload: { scopes: ['assets:read', 'assets:write', 'tickets:read', 'tickets:write'] },
      });
      const tokenDenied = await app.inject({
        method: 'GET',
        url: '/api/backups',
        headers: { authorization: `Bearer ${tokRes.json().token}` },
      });
      expect(tokenDenied.statusCode).toBe(403);

      // Path traversal on download is refused.
      const traversal = await app.inject({
        method: 'GET',
        url: '/api/backups/..%2F..%2Fetc%2Fpasswd',
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(traversal.statusCode).toBe(404);

      // Create a manual backup now.
      const created = await app.inject({
        method: 'POST',
        url: '/api/backups',
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
      });
      expect(created.statusCode).toBe(201);
      const backupName = created.json().name as string;
      expect(backupName).toMatch(/^open-itsm-\d{8}T\d{6}Z-manual\.tar\.gz$/);

      // List shows the backup.
      const list = await app.inject({
        method: 'GET',
        url: '/api/backups',
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().backups.map((b: { name: string }) => b.name)).toContain(backupName);

      // Download the backup archive.
      const downloaded = await app.inject({
        method: 'GET',
        url: `/api/backups/${encodeURIComponent(backupName)}`,
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.headers['content-type']).toBe('application/gzip');
      const archiveFile = path.join(
        tmpdir(),
        `open-itsm-dl-${randomBytes(4).toString('hex')}.tar.gz`,
      );
      writeFileSync(archiveFile, downloaded.rawPayload);

      // Now restore into a brand-new EMPTY PostgreSQL database and fresh attachments directory!
      const freshDbName = `itsm_restore_${randomBytes(6).toString('hex')}`;
      const adminClient = new pg.Client({ connectionString: testDatabaseUrl });
      await adminClient.connect();
      await adminClient.query(`create database ${freshDbName}`);
      await adminClient.end();

      const freshUrl = new URL(testDatabaseUrl);
      freshUrl.pathname = `/${freshDbName}`;
      const freshAttachmentsDir = mkdtempSync(path.join(tmpdir(), 'open-itsm-restored-att-'));

      const freshPool = createPool(freshUrl.toString());
      freshPool.on('error', () => undefined);
      const freshDb = createDb(freshPool);
      const freshApp = await makeApp({
        db: freshDb,
        attachments: new AttachmentStore(freshAttachmentsDir),
      });

      try {
        await restoreBackupArchive(archiveFile, freshUrl.toString(), freshAttachmentsDir);

        // Sign in on the restored install with the original admin account.
        const login = await freshApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'admin@example.com', password: 'correct-horse-battery-staple' },
        });
        expect(login.statusCode).toBe(200);
        const restoredCookie = sessionCookie(login);

        // Verify the asset, ticket, and attachment file all survived the restore intact.
        const restoredAsset = await freshApp.inject({
          method: 'GET',
          url: `/api/assets/by-number/${encodeURIComponent(assetNumber)}`,
          cookies: { [SESSION_COOKIE]: restoredCookie },
        });
        expect(restoredAsset.statusCode).toBe(200);
        expect(restoredAsset.json().name).toBe('ThinkPad X1 Carbon');

        const restoredTicket = await freshApp.inject({
          method: 'GET',
          url: `/api/tickets/${ticketId}`,
          cookies: { [SESSION_COOKIE]: restoredCookie },
        });
        expect(restoredTicket.statusCode).toBe(200);
        expect(restoredTicket.json().subject).toBe('Docking station flickers');

        const restoredFile = await freshApp.inject({
          method: 'GET',
          url: `/api/tickets/${ticketId}/attachments/${attachmentId}`,
          cookies: { [SESSION_COOKIE]: restoredCookie },
        });
        expect(restoredFile.statusCode).toBe(200);
        expect(restoredFile.rawPayload).toEqual(payloadBytes);
      } finally {
        await freshApp.close();
        await freshPool.end();
        const cleanup = new pg.Client({ connectionString: testDatabaseUrl });
        await cleanup.connect();
        await cleanup.query(`drop database if exists ${freshDbName} with (force)`);
        await cleanup.end();
        rmSync(freshAttachmentsDir, { recursive: true, force: true });
        rmSync(archiveFile, { force: true });
      }
    } finally {
      await app.close();
    }
  });

  it('prunes backups older than retentionDays while keeping at least the newest one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'open-itsm-prune-'));
    try {
      const backups = makeBackups(sourceDb.db, {
        databaseUrl: sourceDb.url,
        attachmentsDir: sourceAttachmentsDir,
        backupsDir: dir,
        retentionDays: 14,
      });
      writeFileSync(path.join(dir, 'open-itsm-20260101T020000Z-scheduled.tar.gz'), 'old-1');
      writeFileSync(path.join(dir, 'open-itsm-20260105T020000Z-scheduled.tar.gz'), 'old-2');
      writeFileSync(path.join(dir, 'open-itsm-20261118T020000Z-scheduled.tar.gz'), 'recent');

      const removed = await backups.prune(new Date('2026-11-19T12:00:00Z'));
      expect(removed).toBe(2);
      const remaining = await backups.list();
      expect(remaining.map((b) => b.name)).toEqual(['open-itsm-20261118T020000Z-scheduled.tar.gz']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
