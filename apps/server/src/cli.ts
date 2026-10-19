import { ConfigError, loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import { runRecovery } from './recovery.js';

async function main(): Promise<number> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    return await runRecovery(
      process.argv.slice(2),
      { db: createDb(pool), sessionSecret: config.sessionSecret },
      { out: (line) => console.log(line), err: (line) => console.error(line) },
    );
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  },
);
