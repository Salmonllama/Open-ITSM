import pino from 'pino';
import { buildApp } from './app.js';
import { SetupToken } from './auth/setup-token.js';
import { ConfigError, loadConfig } from './config.js';
import { checkDatabase, createDb, createPool, runMigrations } from './db/client.js';
import { checkQueue, createQueue } from './queue.js';
import { hasUsers } from './routes/setup.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const loggerOptions: pino.LoggerOptions = {
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(config.env === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  };
  const logger = pino(loggerOptions);

  const pool = createPool(config.databaseUrl);
  pool.on('error', (err) => logger.error({ err }, 'database pool error'));
  const db = createDb(pool);

  // A failed migration rolls back and stops startup, leaving the data as it was.
  try {
    await runMigrations(db);
  } catch (err) {
    logger.fatal({ err }, 'database migration failed; refusing to start (no changes were applied)');
    await pool.end();
    process.exit(1);
  }
  logger.info('database migrations applied');

  const setupToken = new SetupToken();
  if (!(await hasUsers(db))) {
    const token = setupToken.issue();
    logger.warn(
      { setupToken: token },
      `First-run setup required. Open the site and enter this setup token: ${token}`,
    );
  }
  const queue = createQueue(config.databaseUrl, logger);
  await queue.start();

  const app = await buildApp({
    version: config.version,
    logger: loggerOptions,
    checks: {
      database: () => checkDatabase(pool),
      queue: () => checkQueue(queue),
    },
    db,
    sessionSecret: config.sessionSecret,
    setupToken,
    webRoot: config.webRoot,
  });

  app.addHook('onClose', async () => {
    await queue.stop({ graceful: true });
    await pool.end();
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ version: config.version }, 'open-itsm started');
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    pino().fatal({ err }, 'failed to start');
  }
  process.exit(1);
});
