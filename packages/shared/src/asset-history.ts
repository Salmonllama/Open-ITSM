import { z } from 'zod';
import { actorSchema, assetStatusSchema } from './assets.js';

const assigneeText = z.string().trim().max(200);
const notesText = z.string().trim().max(4000);

export const assignAssetRequestSchema = z
  .object({
    /** The person who has the asset, as free text (end users are not accounts yet). */
    assignee: assigneeText.default(''),
    /** Where the asset is, as free text. */
    location: assigneeText.default(''),
    notes: notesText.default(''),
  })
  .refine((v) => v.assignee !== '' || v.location !== '', {
    message: 'Enter a person, a location or both',
    path: ['assignee'],
  });
export type AssignAssetRequest = z.input<typeof assignAssetRequestSchema>;

export const returnAssetRequestSchema = z.object({
  /** Where the asset went back to; In stock unless it is being retired. */
  status: z.enum(['in_stock', 'retired']).default('in_stock'),
  notes: notesText.default(''),
});
export type ReturnAssetRequest = z.input<typeof returnAssetRequestSchema>;

export const openRepairRequestSchema = z.object({
  summary: z.string().trim().min(1, 'Say what is being repaired').max(200),
  notes: notesText.default(''),
});
export type OpenRepairRequest = z.input<typeof openRepairRequestSchema>;

export const closeRepairRequestSchema = z.object({
  /** Replaces the repair's notes when given, so the outcome can be recorded. */
  notes: notesText.optional(),
});
export type CloseRepairRequest = z.input<typeof closeRepairRequestSchema>;

export const assignmentSchema = z.object({
  id: z.uuid(),
  assignee: z.string(),
  location: z.string(),
  notes: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  startedBy: actorSchema.nullable(),
  endedBy: actorSchema.nullable(),
});
export type Assignment = z.infer<typeof assignmentSchema>;

export const repairSchema = z.object({
  id: z.uuid(),
  summary: z.string(),
  notes: z.string(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  openedBy: actorSchema.nullable(),
  closedBy: actorSchema.nullable(),
  /** Consumables used for this repair, totalled per item. */
  parts: z.array(z.object({ consumableId: z.uuid(), name: z.string(), quantity: z.int() })),
});
export type Repair = z.infer<typeof repairSchema>;

export const ASSET_EVENT_KINDS = [
  'edited',
  'status_changed',
  'assigned',
  'returned',
  'repair_opened',
  'repair_closed',
] as const;
export const assetEventKindSchema = z.enum(ASSET_EVENT_KINDS);
export type AssetEventKind = z.infer<typeof assetEventKindSchema>;

export const assetEventSchema = z.object({
  id: z.int(),
  kind: assetEventKindSchema,
  at: z.iso.datetime(),
  by: actorSchema.nullable(),
  fromStatus: assetStatusSchema.nullable(),
  toStatus: assetStatusSchema.nullable(),
  /** The assignee or location for assignments, the summary for repairs, what changed for edits. */
  subject: z.string(),
});
export type AssetEvent = z.infer<typeof assetEventSchema>;

/** Newest first in every list. */
export const assetHistorySchema = z.object({
  assignments: z.array(assignmentSchema),
  repairs: z.array(repairSchema),
  activity: z.array(assetEventSchema),
});
export type AssetHistory = z.infer<typeof assetHistorySchema>;

export const assignmentSuggestionsSchema = z.object({
  assignees: z.array(z.string()),
  locations: z.array(z.string()),
});
export type AssignmentSuggestions = z.infer<typeof assignmentSuggestionsSchema>;
