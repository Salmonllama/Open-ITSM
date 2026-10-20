import { timingSafeEqual } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { Role, TokenScope } from '@open-itsm/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { audit } from '../audit.js';
import type { Db } from '../db/client.js';
import type { ActiveSession, SessionStore } from './sessions.js';
import { TOKEN_LIKE, type ActiveToken, type TokenStore, WindowCounter } from './tokens.js';

// __Host- makes browsers require Secure, Path=/ and no Domain, so subdomains cannot set it.
export const SESSION_COOKIE = '__Host-itsm_session';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Who may call a route. Routes are deny-by-default: one without a declaration refuses everyone.
 * `roles` admits signed-in users with one of the roles; `scopes` admits API tokens that hold
 * every listed scope. A route without `scopes` can never be reached with a token.
 */
export type RouteAccess =
  | { public: true }
  | { roles: readonly Role[]; scopes?: readonly TokenScope[] }
  | { roles?: readonly Role[]; scopes: readonly TokenScope[] };

export const PUBLIC: RouteAccess = { public: true };
export const STAFF_ROLES = ['admin', 'technician'] as const satisfies Role[];

declare module 'fastify' {
  interface FastifyRequest {
    session: ActiveSession | null;
    apiToken: ActiveToken | null;
  }
  interface FastifyContextConfig {
    access?: RouteAccess;
    /** Set on routes used before a session exists (login, setup): only the origin is checked. */
    csrf?: 'origin-only';
  }
  interface FastifyInstance {
    /** Every route registered on the app, for the test that checks each declares its access. */
    declaredRoutes: RouteOptions[];
  }
}

export type TokenLimits = {
  /** Requests per minute allowed for one token. */
  perTokenPerMinute: number;
  /** Invalid token attempts from one IP before further token attempts are refused. */
  invalidPerIp: number;
  /** How long an IP's invalid attempts are counted, and so how long the backoff lasts. */
  invalidWindowMs: number;
};

export const DEFAULT_TOKEN_LIMITS: TokenLimits = {
  perTokenPerMinute: 300,
  invalidPerIp: 10,
  invalidWindowMs: 15 * 60 * 1000,
};

function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Browsers send Origin on every cross-site write; a mismatch means another site is posting. */
function isCrossOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin) {
    try {
      const from = new URL(origin);
      const target = new URL(`${request.protocol}://${request.host}`);
      return target.origin !== from.origin;
    } catch {
      return true;
    }
  }
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

/** True when a query string or top-level body value carries something shaped like a token. */
function carriesToken(values: unknown): boolean {
  if (!values || typeof values !== 'object')
    return typeof values === 'string' && TOKEN_LIKE.test(values);
  return Object.values(values).some((v) =>
    Array.isArray(v)
      ? v.some((x) => typeof x === 'string' && TOKEN_LIKE.test(x))
      : typeof v === 'string' && TOKEN_LIKE.test(v),
  );
}

/** Files of the built web UI, registered by @fastify/static, are public like any web page. */
function isStaticFile(route: RouteOptions): boolean {
  const config = route.config as { file?: unknown; rootPath?: unknown } | undefined;
  return config?.file !== undefined && config.rootPath !== undefined;
}

function send(reply: FastifyReply, code: number, error: string, message: string) {
  return reply.code(code).send({ error, message });
}

const INVALID_TOKEN =
  'That API token is not valid. It may be mistyped, expired, revoked or its service account disabled; ask an administrator for a new one.';

export type AuthDeps = {
  db: Db;
  sessions: SessionStore;
  tokens: TokenStore;
  limits?: TokenLimits | undefined;
};

/**
 * Registers credential parsing (session cookie or bearer token), the per-route access check, CSRF
 * checks for sessions, and the audit record of every state-changing token request. Call before
 * any route is registered.
 */
export async function registerAuth(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, sessions, tokens } = deps;
  const limits = deps.limits ?? DEFAULT_TOKEN_LIMITS;
  const perToken = new WindowCounter(limits.perTokenPerMinute, 60 * 1000);
  const invalidByIp = new WindowCounter(limits.invalidPerIp, limits.invalidWindowMs);

  await app.register(fastifyCookie);
  app.decorateRequest('session', null);
  app.decorateRequest('apiToken', null);
  app.decorate('declaredRoutes', []);

  app.addHook('onRoute', (route) => {
    if (!route.config?.access && isStaticFile(route)) {
      route.config = { ...route.config, access: PUBLIC };
    }
    app.declaredRoutes.push(route);
  });

  async function tokenFailure(request: FastifyRequest, reason: string, publicId?: string) {
    // Past the backoff, attempts are refused without an audit row so a flood cannot fill the log.
    if (invalidByIp.hit(request.ip)) {
      request.log.warn({ ip: request.ip, reason }, 'invalid API token attempts over the limit');
      return;
    }
    await audit(db, {
      action: 'token.failed',
      ip: request.ip,
      details: { reason, publicId, method: request.method, route: request.routeOptions.url },
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    // Unknown addresses go to the not-found handler, which serves the web UI or a JSON 404.
    if (request.is404) return;
    const cookie = request.cookies[SESSION_COOKIE];
    const authorization = request.headers.authorization;

    if (cookie && authorization) {
      return send(
        reply,
        400,
        'mixed_credentials',
        'Send either a session cookie or an API token, not both.',
      );
    }
    if (carriesToken(request.query)) {
      if (invalidByIp.blocked(request.ip)) {
        return send(
          reply,
          429,
          'rate_limited',
          'Too many invalid API token attempts. Wait 15 minutes, then try again.',
        );
      }
      await tokenFailure(request, 'token_in_query');
      return send(
        reply,
        400,
        'token_in_url',
        'Send API tokens only in the Authorization header. A token in an address can leak through logs and history, so ask an administrator to revoke it and issue a new one.',
      );
    }

    if (authorization !== undefined) {
      if (invalidByIp.blocked(request.ip)) {
        return send(
          reply,
          429,
          'rate_limited',
          'Too many invalid API token attempts. Wait 15 minutes, then try again.',
        );
      }
      const [scheme, value, extra] = authorization.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !value || extra !== undefined) {
        await tokenFailure(request, 'not_bearer');
        return send(reply, 401, 'invalid_token', INVALID_TOKEN);
      }
      const result = await tokens.verify(value);
      if (!result.ok) {
        await tokenFailure(request, result.reason, result.publicId);
        return send(reply, 401, 'invalid_token', INVALID_TOKEN);
      }
      if (perToken.hit(result.token.id)) {
        return send(
          reply,
          429,
          'rate_limited',
          `This token sent more than ${limits.perTokenPerMinute} requests in a minute. Wait a minute, then try again.`,
        );
      }
      request.apiToken = result.token;
      return;
    }

    // Only the API needs the session; static assets and /healthz skip the lookup.
    if (cookie && request.url.startsWith('/api/')) {
      request.session = (await sessions.find(cookie)) ?? null;
    }
  });

  app.addHook('preValidation', async (request, reply) => {
    if (request.is404) return;
    if (carriesToken(request.body)) {
      await tokenFailure(request, 'token_in_body');
      return send(
        reply,
        400,
        'token_in_body',
        'Send API tokens only in the Authorization header. A token sent in a request body may have been stored or logged, so ask an administrator to revoke it and issue a new one.',
      );
    }

    const access = request.routeOptions.config.access;
    if (!access) {
      request.log.error({ route: request.routeOptions.url }, 'route declares no access; refused');
      return send(reply, 403, 'forbidden', 'This address is not available.');
    }
    if ('public' in access) return;

    if (request.apiToken) {
      if (!access.scopes || access.scopes.length === 0) {
        return send(
          reply,
          403,
          'forbidden',
          'API tokens cannot use this endpoint. Sign in as an administrator instead.',
        );
      }
      const held = request.apiToken.scopes;
      const missing = access.scopes.filter((s) => !held.includes(s));
      if (missing.length > 0) {
        return send(
          reply,
          403,
          'insufficient_scope',
          `This token does not have the ${missing.join(' and ')} scope. Ask an administrator for a token that does.`,
        );
      }
      return;
    }

    if (!request.session) {
      return send(reply, 401, 'unauthenticated', 'Your session has ended. Sign in to continue.');
    }
    if (!access.roles?.includes(request.session.user.role)) {
      return send(
        reply,
        403,
        'forbidden',
        'Your role does not include this. Ask an administrator if you need it.',
      );
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    // Token requests carry no cookie, so a forged cross-site request cannot ride on them.
    if (SAFE_METHODS.has(request.method)) return;
    if (request.apiToken) {
      await audit(db, {
        action: 'token.request',
        actorServiceAccountId: request.apiToken.serviceAccount.id,
        ip: request.ip,
        details: {
          tokenId: request.apiToken.id,
          publicId: request.apiToken.publicId,
          method: request.method,
          route: request.routeOptions.url,
        },
      });
      return;
    }
    if (isCrossOrigin(request)) {
      return send(
        reply,
        403,
        'csrf',
        'This request came from another site, so it was refused. Use Open ITSM from its own address.',
      );
    }
    if (request.session && request.routeOptions.config.csrf !== 'origin-only') {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !sameValue(header, request.session.csrfToken)) {
        return send(
          reply,
          403,
          'csrf',
          'Your session token did not match. Reload the page and try again.',
        );
      }
    }
  });
}

/** The actor columns for a change made by this request. */
export function actorOf(request: FastifyRequest): {
  actorUserId: string | null;
  actorServiceAccountId: string | null;
} {
  return {
    actorUserId: request.session?.user.id ?? null,
    actorServiceAccountId: request.apiToken?.serviceAccount.id ?? null,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
}
