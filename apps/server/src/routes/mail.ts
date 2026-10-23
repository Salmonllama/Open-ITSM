import {
  errorResponseSchema,
  mailSettingsRequestSchema,
  mailSettingsSchema,
  mailStatusSchema,
  mailTestResultSchema,
} from '@open-itsm/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf } from '../auth/http.js';
import { NoSecretError } from '../mail/service.js';
import { ADMIN_ONLY, STAFF_ONLY, type RouteDeps } from './deps.js';

const NO_SECRET = {
  error: 'secret_required',
  message: "Enter the client secret's Value from the app registration.",
} as const;

export function registerMailRoutes(app: FastifyInstance, { mail }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = mail.db;

  r.get(
    '/api/mail/status',
    {
      config: { access: STAFF_ONLY },
      schema: {
        summary: 'Whether the support mailbox is connected, for the ticket list',
        tags: ['mail'],
        response: { 200: mailStatusSchema },
      },
    },
    async () => mail.status(),
  );

  r.get(
    '/api/settings/mail',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'The Microsoft 365 mailbox settings (never the client secret)',
        tags: ['settings'],
        response: { 200: mailSettingsSchema },
      },
    },
    async () => mail.settings(),
  );

  r.put(
    '/api/settings/mail',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Save the Microsoft 365 mailbox settings',
        description:
          'A blank `clientSecret` keeps the stored one. The secret is stored encrypted and never returned. A different mailbox starts afresh: only mail that arrives after saving becomes tickets.',
        tags: ['settings'],
        body: mailSettingsRequestSchema,
        response: { 200: mailSettingsSchema, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      let changed: string[];
      try {
        changed = await mail.save(request.body, actor.actorUserId ?? '');
      } catch (err) {
        if (err instanceof NoSecretError) return reply.code(400).send(NO_SECRET);
        throw err;
      }
      await audit(db, {
        action: 'settings.mail_updated',
        ...actor,
        ip: request.ip,
        details: { changed, mailbox: request.body.mailbox.toLowerCase() },
      });
      if (request.body.enabled) await mail.queue.poll();
      return mail.settings();
    },
  );

  r.post(
    '/api/settings/mail/test',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Sign in to Microsoft and open the mailbox with these settings, without saving',
        description: 'A blank `clientSecret` tests the stored one.',
        tags: ['settings'],
        body: mailSettingsRequestSchema,
        response: { 200: mailTestResultSchema, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      let result;
      try {
        result = await mail.test(request.body);
      } catch (err) {
        if (err instanceof NoSecretError) return reply.code(400).send(NO_SECRET);
        throw err;
      }
      await audit(db, {
        action: 'settings.mail_tested',
        ...actorOf(request),
        ip: request.ip,
        details: { ok: result.ok, step: result.step, mailbox: request.body.mailbox.toLowerCase() },
      });
      return result;
    },
  );

  r.post(
    '/api/settings/mail/check-now',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Check the mailbox now rather than at the next minute',
        tags: ['settings'],
        response: { 202: z.null(), 409: errorResponseSchema },
      },
    },
    async (_request, reply) => {
      if (!(await mail.canSend())) {
        return reply.code(409).send({
          error: 'mail_off',
          message: 'The mailbox is not connected or is switched off. Save the settings first.',
        });
      }
      await mail.queue.poll();
      return reply.code(202).send(null);
    },
  );

  r.delete(
    '/api/settings/mail',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Disconnect the mailbox and forget its client secret',
        description:
          'Tickets and their messages stay. Email stops arriving and replies are not sent.',
        tags: ['settings'],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      if (await mail.disconnect()) {
        await audit(db, {
          action: 'settings.mail_disconnected',
          ...actorOf(request),
          ip: request.ip,
        });
      }
      return reply.code(204).send(null);
    },
  );
}
