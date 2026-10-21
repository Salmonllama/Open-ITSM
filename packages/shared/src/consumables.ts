import { z } from 'zod';
import { actorSchema } from './assets.js';

/** Quantities are whole units (toner cartridges, cables, drives). */
export const CONSUMABLE_QUANTITY_MAX = 1_000_000;

const quantity = z
  .int('Enter a whole number')
  .min(0, 'Enter 0 or more')
  .max(CONSUMABLE_QUANTITY_MAX, `Enter at most ${CONSUMABLE_QUANTITY_MAX.toLocaleString('en')}`);
const amount = z
  .int('Enter a whole number')
  .min(1, 'Enter 1 or more')
  .max(CONSUMABLE_QUANTITY_MAX, `Enter at most ${CONSUMABLE_QUANTITY_MAX.toLocaleString('en')}`);
const reason = z.string().trim().max(500);

export const consumableNameSchema = z.string().trim().min(1, 'Enter a name').max(200);

/** Low means at or below the threshold; a threshold of 0 never flags the item. */
export function isLowStock(item: { quantity: number; lowStockThreshold: number }): boolean {
  return item.lowStockThreshold > 0 && item.quantity <= item.lowStockThreshold;
}

export const consumableSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  quantity: z.int(),
  lowStockThreshold: z.int(),
  low: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Consumable = z.infer<typeof consumableSchema>;

export const CONSUMABLE_PAGE_SIZE = 25;

export const consumableListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** `true` lists only items at or below their threshold. */
  low: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(CONSUMABLE_PAGE_SIZE),
});
export type ConsumableListQuery = z.input<typeof consumableListQuerySchema>;

export const consumableListResponseSchema = z.object({
  items: z.array(consumableSchema),
  total: z.int(),
  page: z.int(),
  pageSize: z.int(),
  /** Items matching the search, whatever the low filter, for the All tab. */
  allCount: z.int(),
  /** Low-stock items matching the search, whatever the low filter. */
  lowCount: z.int(),
});
export type ConsumableListResponse = z.infer<typeof consumableListResponseSchema>;

/** For the low-stock notice and the sidebar count: every low item, lowest stock first. */
export const lowStockSummarySchema = z.object({
  count: z.int(),
  items: z.array(consumableSchema.pick({ id: true, name: true, quantity: true })),
});
export type LowStockSummary = z.infer<typeof lowStockSummarySchema>;

export const createConsumableRequestSchema = z.object({
  name: consumableNameSchema,
  /** The stock on hand now; recorded as the first entry in its history. */
  quantity: quantity.default(0),
  lowStockThreshold: quantity.default(0),
});
export type CreateConsumableRequest = z.input<typeof createConsumableRequestSchema>;

/** The quantity changes only through adjustments, so it has its own history. */
export const updateConsumableRequestSchema = z
  .object({
    name: consumableNameSchema.optional(),
    lowStockThreshold: quantity.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateConsumableRequest = z.infer<typeof updateConsumableRequestSchema>;

export const adjustConsumableRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), amount, reason: reason.default('') }),
  z.object({
    kind: z.literal('use'),
    amount,
    reason: reason.default(''),
    /** An open repair the parts went into. */
    repairId: z.uuid().optional(),
  }),
  z.object({
    kind: z.literal('count'),
    /** The real count after a stocktake; the difference is recorded. */
    quantity,
    reason: reason.min(1, 'Say why the count changed, for example "Stocktake"'),
  }),
]);
export type AdjustConsumableRequest = z.input<typeof adjustConsumableRequestSchema>;

export const CONSUMABLE_ADJUSTMENT_KINDS = ['created', 'added', 'used', 'counted'] as const;
export const consumableAdjustmentKindSchema = z.enum(CONSUMABLE_ADJUSTMENT_KINDS);
export type ConsumableAdjustmentKind = z.infer<typeof consumableAdjustmentKindSchema>;

export const repairRefSchema = z.object({
  id: z.uuid(),
  summary: z.string(),
  asset: z.object({ id: z.uuid(), number: z.string(), name: z.string() }),
});
export type RepairRef = z.infer<typeof repairRefSchema>;

export const consumableAdjustmentSchema = z.object({
  id: z.int(),
  kind: consumableAdjustmentKindSchema,
  /** Signed: positive adds stock, negative takes it out. */
  change: z.int(),
  quantityAfter: z.int(),
  reason: z.string(),
  at: z.iso.datetime(),
  by: actorSchema.nullable(),
  repair: repairRefSchema.nullable(),
});
export type ConsumableAdjustment = z.infer<typeof consumableAdjustmentSchema>;

export const CONSUMABLE_HISTORY_LIMIT = 200;

export const consumableDetailSchema = consumableSchema.extend({
  /** Newest first, at most CONSUMABLE_HISTORY_LIMIT entries. */
  adjustments: z.array(consumableAdjustmentSchema),
  /** True while its history holds nothing but the starting stock, so it can still be deleted. */
  deletable: z.boolean(),
});
export type ConsumableDetail = z.infer<typeof consumableDetailSchema>;

/** Open repairs that parts can be used for, for the Use dialog. */
export const openRepairListSchema = z.array(repairRefSchema);
export type OpenRepairList = z.infer<typeof openRepairListSchema>;
