import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { audit } from '../audit.js';
import type { Db } from '../db/client.js';
import type { BackupService } from './service.js';

const NIGHTLY_BACKUP = 'backup-nightly';

/** Schedules the nightly backup job (02:00 UTC) and audits each run. */
export async function startBackupJobs(
  boss: PgBoss,
  deps: { db: Db; backups: BackupService; log: Logger },
): Promise<void> {
  const { db, backups, log } = deps;
  await boss.createQueue(NIGHTLY_BACKUP, {
    policy: 'exclusive',
    retryLimit: 1,
    retryDelay: 300,
    expireInSeconds: 1800,
  });

  await boss.work(NIGHTLY_BACKUP, async () => {
    try {
      const file = await backups.createBackup('scheduled');
      await audit(db, {
        action: 'backup.created',
        details: { reason: 'scheduled', name: file.name, sizeBytes: file.sizeBytes },
      });
    } catch (err) {
      log.error({ err }, 'nightly backup failed');
      await audit(db, {
        action: 'backup.failed',
        details: { reason: 'scheduled', message: err instanceof Error ? err.message : String(err) },
      }).catch(() => undefined);
      throw err;
    }
  });

  await boss.schedule(NIGHTLY_BACKUP, '0 2 * * *');
}
