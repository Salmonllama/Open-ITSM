import {
  authMethodsSchema,
  entraSettingsRequestSchema,
  entraSettingsSchema,
  entraTestResultSchema,
  errorResponseSchema,
} from '@open-itsm/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import {
  EntraAuthError,
  EntraNoSecretError,
  OIDC_COOKIE,
  OIDC_TTL_SECONDS,
} from '../auth/entra.js';
import { actorOf, PUBLIC, setSessionCookie } from '../auth/http.js';
import { ADMIN_ONLY, AUTH_RATE_LIMIT, type RouteDeps } from './deps.js';

const NO_SECRET = {
  error: 'secret_required',
  message: "Enter the client secret's Value from the Entra ID app registration.",
} as const;

function originOf(request: FastifyRequest, siteUrl: string | null): string {
  return siteUrl ?? `${request.protocol}://${request.host}`;
}

function redirectToLoginError(reply: FastifyReply, message: string) {
  const params = new URLSearchParams({ ssoError: message });
  return reply.redirect(`/login?${params.toString()}`);
}

function clearOidcCookie(reply: FastifyReply) {
  reply.clearCookie(OIDC_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}

export function registerSsoRoutes(
  app: FastifyInstance,
  { db, sessions, entra, portal, mail }: RouteDeps,
) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/auth/methods',
    {
      config: { access: PUBLIC },
      schema: {
        summary: 'Sign-in methods currently enabled for the login page',
        tags: ['auth'],
        response: { 200: authMethodsSchema },
      },
    },
    async () => {
      const [entraEnabled, portalEnabled, mailConnected] = await Promise.all([
        entra.isEnabled(),
        portal.isEnabled(),
        mail.canSend(),
      ]);
      return {
        local: true as const,
        entra: { enabled: entraEnabled },
        emailLink: { enabled: portalEnabled && mailConnected },
      };
    },
  );

  r.get(
    '/api/auth/entra/start',
    {
      config: { access: PUBLIC, rateLimit: AUTH_RATE_LIMIT },
      schema: {
        summary: 'Start Microsoft Entra ID sign-in (OpenID Connect authorization code + PKCE)',
        tags: ['auth'],
        querystring: z.object({ redirect: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const origin = originOf(request, entra.siteUrl);
      const redirectUri = `${origin}/api/auth/entra/callback`;
      try {
        const { authorizationUrl, cookieValue } = await entra.startAuth(
          redirectUri,
          request.query.redirect,
        );
        reply.setCookie(OIDC_COOKIE, cookieValue, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          maxAge: OIDC_TTL_SECONDS,
        });
        return reply.redirect(authorizationUrl);
      } catch (err) {
        const message =
          err instanceof EntraAuthError
            ? err.message
            : 'Microsoft sign-in could not be started. Sign in with your local account instead.';
        await audit(db, {
          action: 'login.failed',
          ip: request.ip,
          details: {
            via: 'entra',
            reason: err instanceof EntraAuthError ? err.code : 'start_failed',
          },
        });
        return redirectToLoginError(reply, message);
      }
    },
  );

  r.get(
    '/api/auth/entra/callback',
    {
      config: { access: PUBLIC, rateLimit: AUTH_RATE_LIMIT },
      schema: {
        summary: 'Complete Microsoft Entra ID sign-in and create a session',
        tags: ['auth'],
      },
    },
    async (request, reply) => {
      const oidcCookie = request.cookies[OIDC_COOKIE];
      clearOidcCookie(reply);
      const origin = originOf(request, entra.siteUrl);
      const callbackUrl = new URL(request.url, origin);
      try {
        const { user, returnTo } = await entra.completeAuth(callbackUrl, oidcCookie);
        const session = await sessions.create(user.id, {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        await audit(db, {
          action: 'login.succeeded',
          actorUserId: user.id,
          ip: request.ip,
          details: { via: 'entra', role: user.role },
        });
        setSessionCookie(reply, session.token, session.expiresAt);
        return reply.redirect(returnTo);
      } catch (err) {
        const message =
          err instanceof EntraAuthError
            ? err.message
            : 'Microsoft sign-in could not be completed. Try again, or sign in with your local account.';
        await audit(db, {
          action: 'login.failed',
          ip: request.ip,
          details: {
            via: 'entra',
            reason: err instanceof EntraAuthError ? err.code : 'callback_failed',
          },
        });
        return redirectToLoginError(reply, message);
      }
    },
  );

  r.get(
    '/api/settings/sso',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Microsoft Entra ID single sign-on settings (never the client secret)',
        tags: ['settings'],
        response: { 200: entraSettingsSchema },
      },
    },
    async () => entra.settings(),
  );

  r.put(
    '/api/settings/sso',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Save Microsoft Entra ID single sign-on settings',
        description:
          'A blank `clientSecret` keeps the stored one. The secret is stored encrypted and never returned. Local accounts are never disabled.',
        tags: ['settings'],
        body: entraSettingsRequestSchema,
        response: { 200: entraSettingsSchema, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      let changed: string[];
      try {
        changed = await entra.save(request.body, actor.actorUserId ?? '');
      } catch (err) {
        if (err instanceof EntraNoSecretError) return reply.code(400).send(NO_SECRET);
        throw err;
      }
      await audit(db, {
        action: 'settings.entra_updated',
        ...actor,
        ip: request.ip,
        details: {
          changed,
          tenantId: request.body.tenantId.toLowerCase(),
          enabled: request.body.enabled,
        },
      });
      return entra.settings();
    },
  );

  r.post(
    '/api/settings/sso/test',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Test OpenID Connect discovery for these Entra ID settings without saving',
        tags: ['settings'],
        body: entraSettingsRequestSchema,
        response: { 200: entraTestResultSchema, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      let result;
      try {
        result = await entra.test(request.body);
      } catch (err) {
        if (err instanceof EntraNoSecretError) return reply.code(400).send(NO_SECRET);
        throw err;
      }
      await audit(db, {
        action: 'settings.entra_tested',
        ...actorOf(request),
        ip: request.ip,
        details: { ok: result.ok, tenantId: request.body.tenantId.toLowerCase() },
      });
      return result;
    },
  );

  r.delete(
    '/api/settings/sso',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Disconnect Entra ID single sign-on and forget its client secret',
        tags: ['settings'],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      if (await entra.disconnect()) {
        await audit(db, {
          action: 'settings.entra_disconnected',
          ...actorOf(request),
          ip: request.ip,
        });
      }
      return reply.code(204).send(null);
    },
  );
}
