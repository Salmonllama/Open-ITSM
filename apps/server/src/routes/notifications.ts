import {
  channelTestResultSchema,
  createChannelRequestSchema,
  errorResponseSchema,
  notificationChannelSchema,
  notificationSettingsSchema,
  updateChannelRequestSchema,
  webhookUrlProblem,
} from '@open-itsm/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf } from '../auth/http.js';
import { ChannelNameTakenError } from '../notifications/service.js';
import { ADMIN_ONLY, type RouteDeps } from './deps.js';

const idParams = z.object({ id: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That channel no longer exists. Reload the page.',
} as const;

const NAME_TAKEN = {
  error: 'name_taken',
  message: 'Another channel already has that name. Choose a different name.',
} as const;

export function registerNotificationRoutes(app: FastifyInstance, { db, notifications }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/settings/notifications',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'The Slack and Teams channels (never their webhook URLs)',
        tags: ['settings'],
        response: { 200: notificationSettingsSchema },
      },
    },
    async () => notifications.settings(),
  );

  r.post(
    '/api/settings/notifications',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Add a Slack or Teams channel',
        description:
          'Slack takes an incoming webhook URL; Teams takes the URL of a workflow made from the "Send webhook alerts to a channel" template. The URL is stored encrypted and never returned. Messages carry the subject and a link, never what was written.',
        tags: ['settings'],
        body: createChannelRequestSchema,
        response: { 201: notificationChannelSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      let channel;
      try {
        channel = await notifications.create(request.body);
      } catch (err) {
        if (err instanceof ChannelNameTakenError) return reply.code(409).send(NAME_TAKEN);
        throw err;
      }
      await audit(db, {
        action: 'settings.channel_created',
        ...actorOf(request),
        ip: request.ip,
        details: { channelId: channel.id, name: channel.name, kind: channel.kind },
      });
      return reply.code(201).send(channel);
    },
  );

  r.put(
    '/api/settings/notifications/:id',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: "Change a channel's name, events or low-stock rule, or switch it off",
        description: 'A blank `webhookUrl` keeps the stored one. The kind never changes.',
        tags: ['settings'],
        params: idParams,
        body: updateChannelRequestSchema,
        response: {
          200: notificationChannelSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const current = await notifications.channel(id);
      if (!current) return reply.code(404).send(NOT_FOUND);
      const { webhookUrl } = request.body;
      const problem = webhookUrl ? webhookUrlProblem(current.kind, webhookUrl) : null;
      if (problem) return reply.code(400).send({ error: 'invalid_webhook_url', message: problem });
      let saved;
      try {
        saved = await notifications.update(id, request.body);
      } catch (err) {
        if (err instanceof ChannelNameTakenError) return reply.code(409).send(NAME_TAKEN);
        throw err;
      }
      if (!saved) return reply.code(404).send(NOT_FOUND);
      if (saved.changed.length > 0) {
        await audit(db, {
          action: 'settings.channel_updated',
          ...actorOf(request),
          ip: request.ip,
          details: { channelId: id, name: saved.channel.name, changed: saved.changed },
        });
      }
      return saved.channel;
    },
  );

  r.post(
    '/api/settings/notifications/:id/test',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Post a test message to a channel now',
        tags: ['settings'],
        params: idParams,
        response: { 200: channelTestResultSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await notifications.test(request.params.id);
      if (!result) return reply.code(404).send(NOT_FOUND);
      await audit(db, {
        action: 'settings.channel_tested',
        ...actorOf(request),
        ip: request.ip,
        details: { channelId: request.params.id, ok: result.ok },
      });
      return result;
    },
  );

  r.delete(
    '/api/settings/notifications/:id',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Remove a channel and forget its webhook URL',
        tags: ['settings'],
        params: idParams,
        response: { 204: z.null(), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const removed = await notifications.remove(request.params.id);
      if (!removed) return reply.code(404).send(NOT_FOUND);
      await audit(db, {
        action: 'settings.channel_deleted',
        ...actorOf(request),
        ip: request.ip,
        details: { channelId: request.params.id, ...removed },
      });
      return reply.code(204).send(null);
    },
  );
}
