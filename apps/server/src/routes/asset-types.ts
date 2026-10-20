import {
  assetFieldSchema,
  assetTypeSchema,
  createAssetTypeRequestSchema,
  createFieldRequestSchema,
  errorResponseSchema,
  updateAssetTypeRequestSchema,
  updateFieldRequestSchema,
  type AssetType,
} from '@open-itsm/shared';
import { and, asc, count, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fieldKey } from '../assets/fields.js';
import { audit } from '../audit.js';
import { actorOf } from '../auth/http.js';
import type { Db } from '../db/client.js';
import { assetEvents, assets, assetTypeFields, assetTypes } from '../db/schema.js';
import { ASSETS_READ, ASSETS_WRITE, isUniqueViolation, type RouteDeps } from './deps.js';

const idParams = z.object({ id: z.uuid() });
const fieldParams = z.object({ id: z.uuid(), fieldId: z.uuid() });

const NOT_FOUND = {
  error: 'not_found',
  message: 'That asset type no longer exists. Reload the page.',
} as const;
const FIELD_NOT_FOUND = {
  error: 'not_found',
  message: 'That field no longer exists. Reload the page.',
} as const;

function conflictMessage(err: unknown) {
  if (isUniqueViolation(err, 'asset_types_name_key')) {
    return { error: 'name_taken', message: 'An asset type with that name already exists.' };
  }
  if (isUniqueViolation(err, 'asset_types_prefix_key')) {
    return {
      error: 'prefix_taken',
      message:
        'Another asset type uses that prefix. Choose a different prefix so numbers stay unique.',
    };
  }
  return undefined;
}

export type Executor = Pick<Db, 'select'>;

export async function loadFields(db: Executor, typeId: string) {
  return db
    .select()
    .from(assetTypeFields)
    .where(eq(assetTypeFields.assetTypeId, typeId))
    .orderBy(asc(assetTypeFields.position), asc(assetTypeFields.createdAt));
}

export async function loadAssetTypes(db: Executor, ids?: string[]): Promise<AssetType[]> {
  const types = await db
    .select()
    .from(assetTypes)
    .where(ids ? inArray(assetTypes.id, ids) : undefined)
    .orderBy(asc(assetTypes.name));
  if (types.length === 0) return [];
  const typeIds = types.map((t) => t.id);
  const [fields, counts] = await Promise.all([
    db
      .select()
      .from(assetTypeFields)
      .where(inArray(assetTypeFields.assetTypeId, typeIds))
      .orderBy(asc(assetTypeFields.position), asc(assetTypeFields.createdAt)),
    db
      .select({ typeId: assets.assetTypeId, n: count() })
      .from(assets)
      .where(inArray(assets.assetTypeId, typeIds))
      .groupBy(assets.assetTypeId),
  ]);
  return types.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    nextNumber: t.nextNumber,
    assetCount: counts.find((c) => c.typeId === t.id)?.n ?? 0,
    fields: fields
      .filter((f) => f.assetTypeId === t.id)
      .map((f) => ({
        id: f.id,
        key: f.key,
        label: f.label,
        kind: f.kind,
        options: f.options,
        required: f.required,
      })),
  }));
}

export function registerAssetTypeRoutes(app: FastifyInstance, { db }: RouteDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function loadOne(id: string) {
    const [type] = await loadAssetTypes(db, [id]);
    return type;
  }

  /** For a row just written in this request, which must exist. */
  async function loadWritten(id: string) {
    const type = await loadOne(id);
    if (!type) throw new Error(`row ${id} not found after write`);
    return type;
  }

  r.get(
    '/api/asset-types',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'List asset types with their custom fields',
        tags: ['asset types'],
        response: { 200: z.array(assetTypeSchema) },
      },
    },
    () => loadAssetTypes(db),
  );

  r.get(
    '/api/asset-types/:id',
    {
      config: { access: ASSETS_READ },
      schema: {
        summary: 'One asset type with its custom fields',
        tags: ['asset types'],
        params: idParams,
        response: { 200: assetTypeSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const type = await loadOne(request.params.id);
      return type ?? reply.code(404).send(NOT_FOUND);
    },
  );

  r.post(
    '/api/asset-types',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Create an asset type, optionally with its custom fields',
        tags: ['asset types'],
        body: createAssetTypeRequestSchema,
        response: { 201: assetTypeSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { name, prefix, fields } = request.body;
      try {
        const id = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(assetTypes)
            .values({ name, prefix })
            .returning({ id: assetTypes.id });
          if (!row) throw new Error('insert returned no row');
          const keys: string[] = [];
          for (const [position, field] of fields.entries()) {
            const key = fieldKey(field.label, keys);
            keys.push(key);
            await tx
              .insert(assetTypeFields)
              .values({ ...field, key, position, assetTypeId: row.id });
          }
          return row.id;
        });
        return reply.code(201).send(await loadWritten(id));
      } catch (err) {
        const conflict = conflictMessage(err);
        if (conflict) return reply.code(409).send(conflict);
        throw err;
      }
    },
  );

  r.patch(
    '/api/asset-types/:id',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Rename an asset type, or change the prefix or next number for new assets',
        tags: ['asset types'],
        params: idParams,
        body: updateAssetTypeRequestSchema,
        response: { 200: assetTypeSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const rows = await db
          .update(assetTypes)
          .set({ ...request.body, updatedAt: new Date() })
          .where(eq(assetTypes.id, id))
          .returning({ id: assetTypes.id });
        if (rows.length === 0) return reply.code(404).send(NOT_FOUND);
        return await loadWritten(id);
      } catch (err) {
        const conflict = conflictMessage(err);
        if (conflict) return reply.code(409).send(conflict);
        throw err;
      }
    },
  );

  r.delete(
    '/api/asset-types/:id',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Delete an asset type that has no assets',
        tags: ['asset types'],
        params: idParams,
        response: { 204: z.null(), 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const outcome = await db.transaction(async (tx) => {
        const [type] = await tx
          .select({ name: assetTypes.name })
          .from(assetTypes)
          .where(eq(assetTypes.id, id))
          .for('update');
        if (!type) return 'not_found' as const;
        const [used] = await tx
          .select({ n: count() })
          .from(assets)
          .where(eq(assets.assetTypeId, id));
        if ((used?.n ?? 0) > 0) return 'in_use' as const;
        await tx.delete(assetTypes).where(eq(assetTypes.id, id));
        await audit(tx, {
          action: 'asset_type.deleted',
          ...actorOf(request),
          ip: request.ip,
          details: { assetTypeId: id, name: type.name },
        });
        return 'deleted' as const;
      });
      if (outcome === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (outcome === 'in_use') {
        return reply.code(409).send({
          error: 'in_use',
          message: 'Assets of this type still exist. Delete or move them first.',
        });
      }
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/api/asset-types/:id/fields',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Add a custom field to an asset type',
        tags: ['asset types'],
        params: idParams,
        body: createFieldRequestSchema,
        response: { 201: assetFieldSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const created = await db.transaction(async (tx) => {
        // Locks the type so two concurrent additions cannot pick the same key.
        const [type] = await tx
          .select({ id: assetTypes.id })
          .from(assetTypes)
          .where(eq(assetTypes.id, id))
          .for('update');
        if (!type) return undefined;
        const existing = await tx
          .select({ key: assetTypeFields.key })
          .from(assetTypeFields)
          .where(eq(assetTypeFields.assetTypeId, id));
        const [last] = await tx
          .select({ position: max(assetTypeFields.position) })
          .from(assetTypeFields)
          .where(eq(assetTypeFields.assetTypeId, id));
        const [row] = await tx
          .insert(assetTypeFields)
          .values({
            ...request.body,
            assetTypeId: id,
            key: fieldKey(
              request.body.label,
              existing.map((f) => f.key),
            ),
            position: (last?.position ?? -1) + 1,
          })
          .returning();
        return row;
      });
      if (!created) return reply.code(404).send(NOT_FOUND);
      return reply.code(201).send({
        id: created.id,
        key: created.key,
        label: created.label,
        kind: created.kind,
        options: created.options,
        required: created.required,
      });
    },
  );

  r.patch(
    '/api/asset-types/:id/fields/:fieldId',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Change a field’s label, choices or whether it is required (not its kind)',
        tags: ['asset types'],
        params: fieldParams,
        body: updateFieldRequestSchema,
        response: { 200: assetFieldSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, fieldId } = request.params;
      const { label, options, required } = request.body;
      const outcome = await db.transaction(async (tx) => {
        const [field] = await tx
          .select()
          .from(assetTypeFields)
          .where(and(eq(assetTypeFields.id, fieldId), eq(assetTypeFields.assetTypeId, id)))
          .for('update');
        if (!field) return 'not_found' as const;
        if (options !== undefined && field.kind !== 'select') return 'not_select' as const;
        if (options !== undefined) {
          // A choice still held by an asset cannot be removed, so stored values stay valid.
          const removed = field.options.filter((o) => !options.includes(o));
          if (options.length === 0) return 'no_options' as const;
          if (removed.length > 0) {
            const inUse = await tx
              .select({ value: sql<string>`${assets.fields} ->> ${field.key}`, n: count() })
              .from(assets)
              .where(
                and(
                  eq(assets.assetTypeId, id),
                  inArray(sql<string>`${assets.fields} ->> ${field.key}`, removed),
                ),
              )
              // By position: the key is bound as a parameter, so repeating the expression would
              // not match the select list.
              .groupBy(sql`1`);
            if (inUse.length > 0) return { inUse };
          }
        }
        const changes: Partial<typeof assetTypeFields.$inferInsert> = {};
        if (label !== undefined) changes.label = label;
        if (options !== undefined) changes.options = options;
        if (required !== undefined) changes.required = required;
        const [updated] = await tx
          .update(assetTypeFields)
          .set(changes)
          .where(eq(assetTypeFields.id, fieldId))
          .returning();
        if (!updated) throw new Error('update returned no row');
        return updated;
      });

      if (outcome === 'not_found') return reply.code(404).send(FIELD_NOT_FOUND);
      if (outcome === 'not_select') {
        return reply.code(409).send({
          error: 'not_select',
          message: 'Only choice-list fields have options.',
        });
      }
      if (outcome === 'no_options') {
        return reply.code(409).send({
          error: 'no_options',
          message: 'A choice list needs at least one option.',
        });
      }
      if ('inUse' in outcome) {
        const list = outcome.inUse
          .map((u) => `“${u.value}” (${u.n} ${u.n === 1 ? 'asset' : 'assets'})`)
          .join(', ');
        return reply.code(409).send({
          error: 'option_in_use',
          message: `Assets still use ${list}. Change those assets first, then remove the option.`,
        });
      }
      return {
        id: outcome.id,
        key: outcome.key,
        label: outcome.label,
        kind: outcome.kind,
        options: outcome.options,
        required: outcome.required,
      };
    },
  );

  r.delete(
    '/api/asset-types/:id/fields/:fieldId',
    {
      config: { access: ASSETS_WRITE },
      schema: {
        summary: 'Delete a custom field and the values assets hold for it',
        tags: ['asset types'],
        params: fieldParams,
        response: { 204: z.null(), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, fieldId } = request.params;
      const deleted = await db.transaction(async (tx) => {
        const typeAssets = await tx
          .select({ id: assets.id, fields: assets.fields })
          .from(assets)
          .where(eq(assets.assetTypeId, id))
          .for('update');
        const [field] = await tx
          .delete(assetTypeFields)
          .where(and(eq(assetTypeFields.id, fieldId), eq(assetTypeFields.assetTypeId, id)))
          .returning({ key: assetTypeFields.key, label: assetTypeFields.label });
        if (!field) return false;
        const affectedAssets = typeAssets.filter((asset) => Object.hasOwn(asset.fields, field.key));
        if (affectedAssets.length > 0) {
          const { actorUserId, actorServiceAccountId } = actorOf(request);
          await tx
            .update(assets)
            .set({
              fields: sql`${assets.fields} - ${field.key}`,
              updatedAt: new Date(),
              updatedByUserId: actorUserId,
              updatedByServiceAccountId: actorServiceAccountId,
            })
            .where(and(eq(assets.assetTypeId, id), sql`${assets.fields} ? ${field.key}`));
          await tx.insert(assetEvents).values(
            affectedAssets.map((asset) => ({
              assetId: asset.id,
              kind: 'edited' as const,
              subject: field.label,
              actorUserId,
              actorServiceAccountId,
            })),
          );
        }
        await audit(tx, {
          action: 'asset_type_field.deleted',
          ...actorOf(request),
          ip: request.ip,
          details: {
            assetTypeId: id,
            fieldId,
            fieldKey: field.key,
            label: field.label,
            affectedAssetCount: affectedAssets.length,
          },
        });
        return true;
      });
      if (!deleted) return reply.code(404).send(FIELD_NOT_FOUND);
      return reply.code(204).send(null);
    },
  );
}
