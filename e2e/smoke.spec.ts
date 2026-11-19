import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('could not allocate port'));
      });
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // Server still starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Open ITSM did not become healthy at ${baseUrl}/healthz in time`);
}

test.describe('Open ITSM v1 end-to-end smoke test (M0–M11)', () => {
  test.skip(!testDatabaseUrl, 'TEST_DATABASE_URL must be set to run E2E smoke tests');

  let dbName: string;
  let baseUrl: string;
  let attachmentsDir: string;
  let backupsDir: string;
  let child: ChildProcess | undefined;
  let setupToken = '';

  test.beforeAll(async () => {
    dbName = `itsm_e2e_${randomBytes(6).toString('hex')}`;
    execFileSync(
      'psql',
      [testDatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${dbName};`],
      {
        stdio: 'pipe',
      },
    );

    const dbUrl = new URL(testDatabaseUrl);
    dbUrl.pathname = `/${dbName}`;

    const port = await getFreePort();
    baseUrl = `http://localhost:${port}`;
    attachmentsDir = mkdtempSync(path.join(tmpdir(), 'open-itsm-e2e-att-'));
    backupsDir = mkdtempSync(path.join(tmpdir(), 'open-itsm-e2e-bak-'));

    const serverEntry = path.join(repoRoot, 'apps', 'server', 'dist', 'server.js');
    const webRoot = path.join(repoRoot, 'apps', 'web', 'dist');

    child = spawn(process.execPath, [serverEntry], {
      cwd: path.join(repoRoot, 'apps', 'server'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_URL: dbUrl.toString(),
        APP_SECRET_KEY: randomBytes(32).toString('base64'),
        SESSION_SECRET: randomBytes(48).toString('base64'),
        APP_HOSTNAME: `localhost:${port}`,
        APP_VERSION: '1.0.0-e2e',
        WEB_ROOT: webRoot,
        ATTACHMENTS_DIR: attachmentsDir,
        BACKUPS_DIR: backupsDir,
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const capture = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { setupToken?: string };
          if (parsed.setupToken) setupToken = parsed.setupToken;
        } catch {
          const match = /setup token:\s*(\S+)/i.exec(line);
          if (match?.[1]) setupToken = match[1];
        }
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    await waitForHealth(baseUrl);
    expect(setupToken).not.toBe('');
  });

  test.afterAll(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    }
    if (testDatabaseUrl && dbName) {
      execFileSync(
        'psql',
        [testDatabaseUrl, '-c', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`],
        { stdio: 'pipe' },
      );
    }
    if (attachmentsDir) rmSync(attachmentsDir, { recursive: true, force: true });
    if (backupsDir) rmSync(backupsDir, { recursive: true, force: true });
  });

  test('walks through M0–M11 acceptance flows in a real browser', async ({ page, request }) => {
    // M0: /healthz reports healthy app, database and queue.
    const health = await request.get(`${baseUrl}/healthz`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      checks: { app: 'ok', database: 'ok', queue: 'ok' },
    });

    // M1: Fresh install opens first-run setup wizard; completes setup; refuses second visit; login works.
    await page.goto(baseUrl);
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel('Setup token').fill(setupToken);
    await page.getByLabel('Your name').fill('E2E Admin');
    await page.getByLabel('Email').fill('admin@example.com');
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery-staple');
    await page.getByLabel('Confirm password').fill('correct-horse-battery-staple');
    await page.getByRole('button', { name: /create administrator/i }).click();

    await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();

    // Second setup visit is refused (redirects away from /setup).
    await page.goto(`${baseUrl}/setup`);
    await expect(page).not.toHaveURL(/\/setup$/);

    // Sign out and sign back in with local credentials.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill('admin@example.com');
    await page.getByLabel('Password').fill('correct-horse-battery-staple');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();

    // M2: Asset types, assets, duplicate protection, service accounts & API tokens.
    await page.getByRole('link', { name: 'Asset types' }).click();
    await page.getByRole('button', { name: 'New asset type' }).click();
    await page.getByLabel('Name').fill('Laptop');
    await page.getByLabel('Number prefix').fill('LAP');
    await page.getByRole('button', { name: 'Create asset type' }).click();
    await expect(
      page.getByRole('heading', { name: 'Laptop' }).or(page.getByRole('link', { name: 'Laptop' })),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Assets', exact: true }).click();
    await page.getByRole('link', { name: 'New asset' }).click();
    await page.getByLabel('Name').fill('ThinkPad T14');
    await page.getByRole('button', { name: 'Create asset' }).click();
    await expect(page.getByRole('heading', { name: 'ThinkPad T14' })).toBeVisible();
    await expect(page.getByText('LAP-000001').first()).toBeVisible();

    // M3: Assign asset (Deployed), log repair (In repair), close repair (back to Deployed).
    await page.getByRole('button', { name: 'Assign' }).click();
    const assignDialog = page.locator('dialog[open]');
    await assignDialog.getByLabel('Person').fill('Jordan Rivera');
    await assignDialog.getByRole('button', { name: 'Assign' }).click();
    await expect(page.getByText('Jordan Rivera').first()).toBeVisible();

    await page.getByRole('button', { name: 'Log repair' }).click();
    const repairDialog = page.locator('dialog[open]');
    await repairDialog.getByLabel('Repair').fill('Replace battery');
    await repairDialog.getByRole('button', { name: 'Log repair' }).click();
    await expect(page.getByText('In repair').first()).toBeVisible();

    await page.getByRole('button', { name: 'Close repair' }).click();
    const closeDialog = page.locator('dialog[open]');
    await closeDialog.getByRole('button', { name: 'Close repair' }).click();
    await expect(page.getByText('Deployed').first()).toBeVisible();

    // M4: Printable QR label page & keyboard-input Scan page lookup.
    await page.getByRole('link', { name: 'Print tag' }).click();
    await expect(page).toHaveURL(/\/assets\/labels/);
    await expect(page.getByText('LAP-000001')).toBeVisible();

    await page.getByRole('link', { name: 'Scan' }).click();
    await page.getByLabel('Asset number or tag').fill('LAP-000001');
    await page.getByLabel('Asset number or tag').press('Enter');
    await expect(page.getByRole('heading', { name: 'ThinkPad T14' })).toBeVisible();

    // M5: Consumables with low-stock threshold and indicator.
    await page.getByRole('link', { name: 'Consumables' }).click();
    await page.getByRole('button', { name: 'New consumable' }).click();
    const consumableDialog = page.locator('dialog[open]');
    await consumableDialog.getByLabel('Name').fill('USB-C Charger');
    await consumableDialog.getByLabel('In stock').fill('2');
    await consumableDialog.getByLabel('Low-stock threshold').fill('2');
    await consumableDialog.getByRole('button', { name: 'Add consumable' }).click();
    await expect(page.getByText('Low stock').first()).toBeVisible();

    // M6: Tickets — create and reply.
    await page.getByRole('link', { name: /Tickets/ }).click();
    await page.getByRole('button', { name: 'New ticket' }).click();
    const ticketDialog = page.locator('dialog[open]');
    await ticketDialog.getByLabel('Requester email').fill('jamie@example.com');
    await ticketDialog.getByLabel('Subject').fill('Printer out of toner');
    await ticketDialog.locator('textarea').fill('The 3rd floor printer needs black toner.');
    await ticketDialog.getByRole('button', { name: 'Open ticket' }).click();
    await expect(page.getByRole('heading', { name: 'Printer out of toner' })).toBeVisible();

    await page.locator('textarea').fill('On my way with a fresh cartridge.');
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByText('On my way with a fresh cartridge.')).toBeVisible();

    // M7, M8, M9: Admin integration pages load cleanly.
    await page.getByRole('link', { name: 'Email' }).click();
    await expect(page.getByRole('heading', { name: 'Email' })).toBeVisible();

    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

    await page.getByRole('link', { name: 'Single sign-on' }).click();
    await expect(page.getByRole('heading', { name: 'Single sign-on' })).toBeVisible();

    // M10: End-user portal is off by default, can be switched on.
    await page.getByRole('link', { name: 'End-user portal' }).click();
    await expect(page.getByRole('heading', { name: 'End-user portal' })).toBeVisible();
    await expect(page.getByText('The end-user portal is switched off.')).toBeVisible();
    await page.getByRole('button', { name: 'Switch on' }).click();
    await expect(page.getByText(/Requesters can sign in/)).toBeVisible();

    // M11: Backups page — create a backup now and verify it appears in the list.
    await page.getByRole('link', { name: 'Backups' }).click();
    await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
    await page.getByRole('button', { name: 'Backup now' }).click();
    await expect(page.getByText(/open-itsm-\d{8}T\d{6}Z-manual\.tar\.gz/).first()).toBeVisible();
  });
});
