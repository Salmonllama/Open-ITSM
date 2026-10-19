import { timingSafeEqual } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Role } from '@open-itsm/shared';
import type { ActiveSession, SessionStore } from './sessions.js';

// __Host- makes browsers require Secure, Path=/ and no Domain, so subdomains cannot set it.
export const SESSION_COOKIE = '__Host-itsm_session';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    session: ActiveSession | null;
  }
  interface FastifyContextConfig {
    /** Set on routes used before a session exists (login, setup): only the origin is checked. */
    csrf?: 'origin-only';
  }
}

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
      // Parse the Host header with the origin's scheme so default ports compare equal.
      return new URL(`${from.protocol}//${request.host}`).host !== from.host;
    } catch {
      return true;
    }
  }
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

function forbidden(reply: FastifyReply, message: string) {
  return reply.code(403).send({ error: 'csrf', message });
}

/** Registers cookie parsing, session lookup and CSRF checks on the root instance. */
export async function registerAuth(app: FastifyInstance, sessions: SessionStore): Promise<void> {
  await app.register(fastifyCookie);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request) => {
    // Only the API needs the session; static assets and /healthz skip the lookup.
    if (!request.url.startsWith('/api/')) return;
    const token = request.cookies[SESSION_COOKIE];
    request.session = token ? ((await sessions.find(token)) ?? null) : null;
  });

  app.addHook('preHandler', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (isCrossOrigin(request)) {
      return forbidden(
        reply,
        'This request came from another site, so it was refused. Use Open ITSM from its own address.',
      );
    }
    if (request.session && request.routeOptions.config.csrf !== 'origin-only') {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !sameValue(header, request.session.csrfToken)) {
        return forbidden(reply, 'Your session token did not match. Reload the page and try again.');
      }
    }
  });
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

/** Rejects requests without a session (401) or whose user lacks one of the roles (403). */
export function requireRole(...roles: Role[]): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.session) {
      return reply.code(401).send({
        error: 'unauthenticated',
        message: 'Your session has ended. Sign in to continue.',
      });
    }
    if (!roles.includes(request.session.user.role)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Your role does not include this. Ask an administrator if you need it.',
      });
    }
  };
}
