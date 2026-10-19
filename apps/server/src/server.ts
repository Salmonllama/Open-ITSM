import pino from 'pino';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { checkDatabase, createPool } from './db.js';
import { checkQueue, createQueue } from './queue.js';

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
  const queue = createQueue(config.databaseUrl, logger);
  await queue.start();

  const app = await buildApp({
    version: config.version,
    logger: loggerOptions,
    checks: {
      database: () => checkDatabase(pool),
      queue: () => checkQueue(queue),
    },
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
