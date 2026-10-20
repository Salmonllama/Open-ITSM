import { z } from 'zod';

export const ASSET_STATUSES = [
  'preparing',
  'in_stock',
  'deployed',
  'in_repair',
  'retired',
] as const;
export const assetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

export const assetStatusLabels: Record<AssetStatus, string> = {
  preparing: 'Preparing',
  in_stock: 'In stock',
  deployed: 'Deployed',
  in_repair: 'In repair',
  retired: 'Retired',
};

/**
 * Statuses a person may set directly (on create, edit or import). Deployed comes from assigning
 * an asset and In repair from opening a repair, so those two always match the history.
 */
export const SETTABLE_ASSET_STATUSES = ['preparing', 'in_stock', 'retired'] as const;
export const settableAssetStatusSchema = z.enum(SETTABLE_ASSET_STATUSES);
export type SettableAssetStatus = z.infer<typeof settableAssetStatusSchema>;

export function isSettableStatus(status: AssetStatus): status is SettableAssetStatus {
  return (SETTABLE_ASSET_STATUSES as readonly string[]).includes(status);
}

export const FIELD_KINDS = ['text', 'number', 'date', 'select', 'boolean'] as const;
export const fieldKindSchema = z.enum(FIELD_KINDS);
export type FieldKind = z.infer<typeof fieldKindSchema>;

export const fieldKindLabels: Record<FieldKind, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Choice list',
  boolean: 'Yes/no',
};

export const ASSET_NUMBER_DIGITS = 6;
export const TEXT_FIELD_MAX = 1000;

/** `LAP` and 123 make `LAP-000123`. */
export function formatAssetNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(ASSET_NUMBER_DIGITS, '0')}`;
}

export const assetTypeNameSchema = z.string().trim().min(1, 'Enter a name').max(100);
export const assetPrefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,10}$/, 'Use 1 to 10 letters or digits, like LAP');
export const assetNumberSchema = z
  .string()
  .trim()
  .min(1, 'Enter an asset number')
  .max(64, 'Use at most 64 characters')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'Use letters, digits, dashes, dots, slashes or underscores',
  );
export const assetNameSchema = z.string().trim().min(1, 'Enter a name').max(200);
export const fieldLabelSchema = z.string().trim().min(1, 'Enter a label').max(100);
export const fieldOptionsSchema = z
  .array(z.string().trim().min(1, 'Options cannot be blank').max(100))
  .max(100)
  .refine((o) => new Set(o).size === o.length, 'Each option must be different');

export const assetFieldSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  kind: fieldKindSchema,
  options: z.array(z.string()),
  required: z.boolean(),
});
export type AssetField = z.infer<typeof assetFieldSchema>;

export const assetTypeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  nextNumber: z.int(),
  fields: z.array(assetFieldSchema),
  assetCount: z.int(),
});
export type AssetType = z.infer<typeof assetTypeSchema>;

export const createFieldRequestSchema = z
  .object({
    label: fieldLabelSchema,
    kind: fieldKindSchema,
    options: fieldOptionsSchema.default([]),
    required: z.boolean().default(false),
  })
  .refine((f) => f.kind !== 'select' || f.options.length > 0, {
    message: 'A choice list needs at least one option',
    path: ['options'],
  });
export type CreateFieldRequest = z.input<typeof createFieldRequestSchema>;

/** The kind of a field is fixed once created, so stored values always match it. */
export const updateFieldRequestSchema = z
  .object({
    label: fieldLabelSchema.optional(),
    options: fieldOptionsSchema.optional(),
    required: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateFieldRequest = z.infer<typeof updateFieldRequestSchema>;

export const createAssetTypeRequestSchema = z.object({
  name: assetTypeNameSchema,
  prefix: assetPrefixSchema,
  fields: z.array(createFieldRequestSchema).max(50).default([]),
});
export type CreateAssetTypeRequest = z.input<typeof createAssetTypeRequestSchema>;

export const updateAssetTypeRequestSchema = z
  .object({
    name: assetTypeNameSchema.optional(),
    prefix: assetPrefixSchema.optional(),
    nextNumber: z.int().min(1).max(999_999_999).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateAssetTypeRequest = z.infer<typeof updateAssetTypeRequestSchema>;

export const fieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type FieldValue = z.infer<typeof fieldValueSchema>;
export const fieldValuesSchema = z.record(z.string(), fieldValueSchema);
export type FieldValues = z.infer<typeof fieldValuesSchema>;

export const actorSchema = z.object({
  kind: z.enum(['user', 'service_account']),
  name: z.string(),
});
export type Actor = z.infer<typeof actorSchema>;

export const assetSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  name: z.string(),
  status: assetStatusSchema,
  type: z.object({ id: z.uuid(), name: z.string() }),
  updatedAt: z.iso.datetime(),
});
export type AssetSummary = z.infer<typeof assetSummarySchema>;

export const assetSchema = assetSummarySchema.extend({
  fields: fieldValuesSchema,
  createdAt: z.iso.datetime(),
  updatedBy: actorSchema.nullable(),
});
export type Asset = z.infer<typeof assetSchema>;

export const ASSET_PAGE_SIZE = 25;

export const assetListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: assetStatusSchema.optional(),
  typeId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(ASSET_PAGE_SIZE),
});
export type AssetListQuery = z.input<typeof assetListQuerySchema>;

export const assetListResponseSchema = z.object({
  items: z.array(assetSummarySchema),
  total: z.int(),
  page: z.int(),
  pageSize: z.int(),
  /** Counts per status for the current search and type filter, ignoring the status filter. */
  counts: z.object({
    all: z.int(),
    preparing: z.int(),
    in_stock: z.int(),
    deployed: z.int(),
    in_repair: z.int(),
    retired: z.int(),
  }),
});
export type AssetListResponse = z.infer<typeof assetListResponseSchema>;

export const createAssetRequestSchema = z.object({
  typeId: z.uuid(),
  /** Leave out to take the next number from the type's sequence. */
  number: assetNumberSchema.optional(),
  name: assetNameSchema,
  status: settableAssetStatusSchema.default('in_stock'),
  fields: fieldValuesSchema.default({}),
});
export type CreateAssetRequest = z.input<typeof createAssetRequestSchema>;

export const updateAssetRequestSchema = z
  .object({
    number: assetNumberSchema.optional(),
    name: assetNameSchema.optional(),
    status: settableAssetStatusSchema.optional(),
    /** Replaces every custom field value; leave a key out to clear it. */
    fields: fieldValuesSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateAssetRequest = z.infer<typeof updateAssetRequestSchema>;

export const IMPORT_MAX_ROWS = 5000;

export const importProblemSchema = z.object({
  /** 1-based line in the file, counting the header as line 1; null for file-level problems. */
  line: z.int().nullable(),
  column: z.string().nullable(),
  message: z.string(),
});
export type ImportProblem = z.infer<typeof importProblemSchema>;

export const importResultSchema = z.object({
  dryRun: z.boolean(),
  rows: z.int(),
  created: z.int(),
  problems: z.array(importProblemSchema),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const importQuerySchema = z.object({
  typeId: z.uuid(),
  dryRun: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
