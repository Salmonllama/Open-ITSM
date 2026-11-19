import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BackupFile, BackupReason, BackupStatus } from '@open-itsm/shared';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

const execFileAsync = promisify(execFile);

const STATE_KEY = 'backups.state';
const BACKUP_TIMEOUT_MS = 10 * 60 * 1000;

/** Strict filename pattern: prevents path traversal on download and lets us parse metadata. */
export const BACKUP_NAME_RE =
  /^open-itsm-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(scheduled|manual|pre_migration)\.tar\.gz$/;

type StoredBackupState = {
  lastBackupAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
};

export type BackupOptions = {
  databaseUrl: string;
  attachmentsDir: string;
  backupsDir: string;
  retentionDays: number;
  appVersion: string;
};

/** Parses a postgres:// URL into PG* env vars so passwords never appear in process argv. */
export function pgEnvFromUrl(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const dbName = url.pathname.replace(/^\//, '');
  if (dbName) env.PGDATABASE = decodeURIComponent(dbName);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

function formatTimestampForName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    'T',
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
    'Z',
  ].join('');
}

export function parseBackupName(name: string): { createdAt: string; reason: BackupReason } | null {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, reason] = m;
  return {
    createdAt: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`,
    reason: reason as BackupReason,
  };
}

export class BackupInProgressError extends Error {
  constructor() {
    super('A backup is already running. Wait a moment and refresh.');
    this.name = 'BackupInProgressError';
  }
}

/**
 * Takes portable `.tar.gz` backups containing a PostgreSQL custom-format dump (`database.dump`),
 * a `manifest.json`, and the attachments volume (`attachments/`), and prunes old backups past
 * `retentionDays`.
 */
export class BackupService {
  private running = false;

  constructor(
    readonly db: Db | null,
    private readonly options: BackupOptions,
    private readonly log: Logger,
  ) {}

  get retentionDays(): number {
    return this.options.retentionDays;
  }

  private async loadState(): Promise<StoredBackupState> {
    if (!this.db) return {};
    try {
      const [row] = await this.db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, STATE_KEY));
      return (row?.value ?? {}) as StoredBackupState;
    } catch {
      return {};
    }
  }

  private async saveState(patch: Partial<StoredBackupState>): Promise<void> {
    if (!this.db) return;
    try {
      const now = new Date();
      const prev = await this.loadState();
      const next: StoredBackupState = { ...prev, ...patch };
      await this.db
        .insert(settings)
        .values({ key: STATE_KEY, value: next, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } });
    } catch (err) {
      this.log.warn({ err }, 'could not record backup status');
    }
  }

  async list(): Promise<BackupFile[]> {
    await mkdir(this.options.backupsDir, { recursive: true });
    const entries = await readdir(this.options.backupsDir);
    const items: BackupFile[] = [];
    for (const name of entries) {
      const parsed = parseBackupName(name);
      if (!parsed) continue;
      try {
        const info = await stat(path.join(this.options.backupsDir, name));
        if (!info.isFile()) continue;
        items.push({
          name,
          reason: parsed.reason,
          createdAt: parsed.createdAt,
          sizeBytes: info.size,
        });
      } catch {
        // Ignore a file that vanished concurrently.
      }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
    return items;
  }

  async status(): Promise<BackupStatus> {
    const [backups, state] = await Promise.all([this.list(), this.loadState()]);
    const failing =
      state.lastError != null &&
      (state.lastBackupAt == null ||
        (state.lastErrorAt != null && state.lastErrorAt > state.lastBackupAt));
    return {
      retentionDays: this.options.retentionDays,
      lastBackupAt: state.lastBackupAt ?? backups[0]?.createdAt ?? null,
      lastError: failing ? (state.lastError ?? null) : null,
      lastErrorAt: failing ? (state.lastErrorAt ?? null) : null,
      backups,
    };
  }

  async createBackup(reason: BackupReason, now = new Date()): Promise<BackupFile> {
    if (this.running) throw new BackupInProgressError();
    this.running = true;
    const stageDir = await mkdtemp(path.join(tmpdir(), 'open-itsm-backup-'));
    try {
      await mkdir(this.options.backupsDir, { recursive: true });
      const dumpPath = path.join(stageDir, 'database.dump');
      await execFileAsync(
        'pg_dump',
        ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath],
        { env: pgEnvFromUrl(this.options.databaseUrl), timeout: BACKUP_TIMEOUT_MS },
      );

      let includesAttachments = false;
      if (existsSync(this.options.attachmentsDir)) {
        const entries = await readdir(this.options.attachmentsDir);
        if (entries.length > 0) {
          await cp(this.options.attachmentsDir, path.join(stageDir, 'attachments'), {
            recursive: true,
          });
          includesAttachments = true;
        }
      }

      const manifest = {
        formatVersion: 1,
        appVersion: this.options.appVersion,
        reason,
        createdAt: now.toISOString(),
        includesAttachments,
      };
      await writeFile(
        path.join(stageDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        'utf8',
      );

      const finalName = `open-itsm-${formatTimestampForName(now)}-${reason}.tar.gz`;
      const tmpArchive = path.join(this.options.backupsDir, `.${finalName}.tmp`);
      const finalPath = path.join(this.options.backupsDir, finalName);
      const tarEntries = includesAttachments
        ? ['manifest.json', 'database.dump', 'attachments']
        : ['manifest.json', 'database.dump'];
      await execFileAsync('tar', ['-czf', tmpArchive, '-C', stageDir, ...tarEntries], {
        timeout: BACKUP_TIMEOUT_MS,
      });
      await rename(tmpArchive, finalPath);

      const info = await stat(finalPath);
      const created: BackupFile = {
        name: finalName,
        reason,
        createdAt: parseBackupName(finalName)?.createdAt ?? now.toISOString(),
        sizeBytes: info.size,
      };

      await this.prune(now);
      await this.saveState({
        lastBackupAt: created.createdAt,
        lastError: null,
        lastErrorAt: null,
      });
      this.log.info({ name: created.name, reason, sizeBytes: created.sizeBytes }, 'backup created');
      return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.saveState({
        lastError: message.slice(0, 500),
        lastErrorAt: new Date().toISOString(),
      });
      this.log.error({ err, reason }, 'backup failed');
      throw err;
    } finally {
      this.running = false;
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Removes backups older than `retentionDays`, always keeping at least the newest one. */
  async prune(now = new Date()): Promise<number> {
    const backups = await this.list();
    if (backups.length <= 1) return 0;
    const cutoffMs = now.getTime() - this.options.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const file of backups.slice(1)) {
      if (Date.parse(file.createdAt) < cutoffMs) {
        await rm(path.join(this.options.backupsDir, file.name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  async openForDownload(name: string): Promise<{
    name: string;
    sizeBytes: number;
    stream: ReturnType<typeof createReadStream>;
  } | null> {
    if (!parseBackupName(name)) return null;
    const fullPath = path.join(this.options.backupsDir, name);
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) return null;
      return { name, sizeBytes: info.size, stream: createReadStream(fullPath) };
    } catch {
      return null;
    }
  }
}

/**
 * Restores a backup archive into a target PostgreSQL database and attachments directory.
 * Mirrors what `scripts/restore.sh` does for Docker Compose installs.
 */
export async function restoreBackupArchive(
  archivePath: string,
  targetDatabaseUrl: string,
  targetAttachmentsDir: string,
): Promise<void> {
  const stageDir = await mkdtemp(path.join(tmpdir(), 'open-itsm-restore-'));
  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', stageDir], {
      timeout: BACKUP_TIMEOUT_MS,
    });
    const dumpPath = path.join(stageDir, 'database.dump');
    if (!existsSync(dumpPath)) {
      throw new Error('Backup archive is missing database.dump');
    }
    await execFileAsync(
      'pg_restore',
      [
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '--dbname',
        pgEnvFromUrl(targetDatabaseUrl).PGDATABASE ?? 'postgres',
        dumpPath,
      ],
      { env: pgEnvFromUrl(targetDatabaseUrl), timeout: BACKUP_TIMEOUT_MS },
    );

    const extractedAttachments = path.join(stageDir, 'attachments');
    await mkdir(targetAttachmentsDir, { recursive: true });
    if (existsSync(extractedAttachments)) {
      await cp(extractedAttachments, targetAttachmentsDir, { recursive: true, force: true });
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
