import { healthResponseSchema, type ComponentStatus, type HealthResponse } from '@open-itsm/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/** Resolves true when the component is usable; false or a rejection means it is not. */
export type HealthCheck = () => Promise<boolean>;

export type HealthOptions = {
  version: string;
  checks: { database: HealthCheck; queue: HealthCheck };
  timeoutMs?: number;
};

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return (await Promise.race([check(), timeout])) ? 'ok' : 'error';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealthRoute(app: FastifyInstance, options: HealthOptions): void {
  const timeoutMs = options.timeoutMs ?? 2000;
  const startedAt = Date.now();

  app.withTypeProvider<ZodTypeProvider>().get(
    '/healthz',
    {
      schema: {
        summary: 'Report app, database and queue status',
        tags: ['system'],
        response: { 200: healthResponseSchema, 503: healthResponseSchema },
      },
      logLevel: 'warn',
    },
    async (_request, reply) => {
      const [database, queue] = await Promise.all([
        runCheck(options.checks.database, timeoutMs),
        runCheck(options.checks.queue, timeoutMs),
      ]);
      const healthy = database === 'ok' && queue === 'ok';
      const body: HealthResponse = {
        status: healthy ? 'ok' : 'error',
        version: options.version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        checks: { app: 'ok', database, queue },
      };
      return reply.code(healthy ? 200 : 503).send(body);
    },
  );
}
