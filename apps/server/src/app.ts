import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerAuth, STAFF_ROLES, type TokenLimits } from './auth/http.js';
import { SessionStore } from './auth/sessions.js';
import { TokenStore } from './auth/tokens.js';
import type { SetupToken } from './auth/setup-token.js';
import type { Db } from './db/client.js';
import { registerHealthRoute, type HealthCheck } from './health.js';
import { registerAssetTypeRoutes } from './routes/asset-types.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConsumableRoutes } from './routes/consumables.js';
import { registerServiceAccountRoutes } from './routes/service-accounts.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerUserRoutes } from './routes/users.js';

export type AppOptions = {
  version: string;
  logger: FastifyServerOptions['logger'];
  checks: { database: HealthCheck; queue: HealthCheck };
  db: Db;
  sessionSecret: string;
  setupToken: SetupToken;
  /** Directory holding the built web UI. Static serving is skipped when unset or missing. */
  webRoot?: string | undefined;
  /** Per-token and invalid-token limits; tests lower them. */
  tokenLimits?: TokenLimits | undefined;
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

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const first = err.validation[0];
      const field = first?.instancePath.replace(/^\//, '').replaceAll('/', '.');
      const message = first
        ? `${field ? `${field}: ` : ''}${first.message ?? 'is invalid'}`
        : 'The request was not valid. Check the form and try again.';
      return reply.code(400).send({ error: 'validation', message });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many requests in a short time. Wait a minute, then try again.',
      });
    }
    if (status < 500) {
      return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal',
      message:
        'Something went wrong on the server. Try again; if it keeps happening, check the app log.',
    });
  });

  await app.register(fastifyRateLimit, { global: false });
  const sessions = new SessionStore(options.db, options.sessionSecret);
  const tokens = new TokenStore(options.db);
  await registerAuth(app, { db: options.db, sessions, tokens, limits: options.tokenLimits });

  // The API reference is for signed-in administrators and technicians only, never tokens.
  await app.register(async (docs) => {
    docs.addHook('onRoute', (route) => {
      route.config = { ...route.config, access: { roles: STAFF_ROLES } };
    });
    await docs.register(fastifySwaggerUi, { routePrefix: '/api/docs' });
  });

  // CSV import sends the file as the body; other routes take JSON only.
  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );

  registerHealthRoute(app, { version: options.version, checks: options.checks });
  const deps = { db: options.db, sessions, tokens, setupToken: options.setupToken };
  registerSetupRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerServiceAccountRoutes(app, deps);
  registerAssetTypeRoutes(app, deps);
  registerAssetRoutes(app, deps);
  registerConsumableRoutes(app, deps);

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
    return reply
      .code(404)
      .send({ error: 'not_found', message: 'There is no API route at this address.' });
  });

  return app;
}
