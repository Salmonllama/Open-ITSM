import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerHealthRoute, type HealthCheck } from './health.js';

export type AppOptions = {
  version: string;
  logger: FastifyServerOptions['logger'];
  checks: { database: HealthCheck; queue: HealthCheck };
  /** Directory holding the built web UI. Static serving is skipped when unset or missing. */
  webRoot?: string | undefined;
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger,
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'Open ITSM API', version: options.version },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/api/docs' });

  registerHealthRoute(app, { version: options.version, checks: options.checks });

  const webRoot = options.webRoot ? path.resolve(options.webRoot) : undefined;
  const serveWeb = webRoot !== undefined && existsSync(path.join(webRoot, 'index.html'));
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const isPageRequest =
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      (request.headers.accept ?? '').includes('text/html');
    if (serveWeb && isPageRequest) {
      // Client-side routes are resolved by the web UI.
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Route not found' });
  });

  return app;
}
