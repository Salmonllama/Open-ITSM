import { backupFileSchema, backupStatusSchema, errorResponseSchema } from '@open-itsm/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf } from '../auth/http.js';
import { BackupInProgressError } from '../backups/service.js';
import { ADMIN_ONLY, type RouteDeps } from './deps.js';

export function registerBackupRoutes(app: FastifyInstance, { db, backups }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/backups',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'List backups in the backups volume and the nightly backup status',
        tags: ['backups'],
        response: { 200: backupStatusSchema },
      },
    },
    async () => backups.status(),
  );

  r.post(
    '/api/backups',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Take a backup of the database and attachments now',
        tags: ['backups'],
        response: {
          201: backupFileSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      try {
        const created = await backups.createBackup('manual');
        await audit(db, {
          action: 'backup.created',
          ...actor,
          ip: request.ip,
          details: { reason: 'manual', name: created.name, sizeBytes: created.sizeBytes },
        });
        return reply.code(201).send(created);
      } catch (err) {
        if (err instanceof BackupInProgressError) {
          return reply.code(409).send({ error: 'backup_in_progress', message: err.message });
        }
        await audit(db, {
          action: 'backup.failed',
          ...actor,
          ip: request.ip,
          details: { reason: 'manual', message: err instanceof Error ? err.message : String(err) },
        }).catch(() => undefined);
        return reply.code(500).send({
          error: 'backup_failed',
          message:
            'The backup could not be created. Check that pg_dump is available and the backups volume is writable.',
        });
      }
    },
  );

  r.get(
    '/api/backups/:name',
    {
      config: { access: ADMIN_ONLY },
      schema: {
        summary: 'Download a backup archive',
        tags: ['backups'],
        params: z.object({ name: z.string().min(1).max(200) }),
        response: { 200: z.any().describe('Backup archive (.tar.gz)'), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const opened = await backups.openForDownload(request.params.name);
      if (!opened) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'That backup file no longer exists.',
        });
      }
      await audit(db, {
        action: 'backup.downloaded',
        ...actorOf(request),
        ip: request.ip,
        details: { name: opened.name, sizeBytes: opened.sizeBytes },
      });
      return reply
        .header('content-type', 'application/gzip')
        .header('content-length', String(opened.sizeBytes))
        .header('content-disposition', `attachment; filename="${opened.name}"`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(opened.stream);
    },
  );
}
