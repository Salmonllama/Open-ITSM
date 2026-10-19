import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

export function createQueue(databaseUrl: string, logger: Logger): PgBoss {
  const boss = new PgBoss({ connectionString: databaseUrl, max: 4 });
  boss.on('error', (err) => logger.error({ err }, 'job queue error'));
  return boss;
}

export async function checkQueue(boss: PgBoss): Promise<boolean> {
  return boss.isInstalled();
}
