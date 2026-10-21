import {
  ASSET_EVENT_KINDS,
  ASSET_STATUSES,
  CONSUMABLE_ADJUSTMENT_KINDS,
  FIELD_KINDS,
  TOKEN_SCOPES,
} from '@open-itsm/shared';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['admin', 'technician', 'end_user']);
export const assetStatus = pgEnum('asset_status', ASSET_STATUSES);
export const fieldKind = pgEnum('field_kind', FIELD_KINDS);
export const assetEventKind = pgEnum('asset_event_kind', ASSET_EVENT_KINDS);
export const consumableAdjustmentKind = pgEnum(
  'consumable_adjustment_kind',
  CONSUMABLE_ADJUSTMENT_KINDS,
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull(),
    passwordHash: text('password_hash'),
    entraSubject: text('entra_subject'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    uniqueIndex('users_entra_subject_key').on(t.entraSubject),
    // Emails are stored normalized so the unique index is case-insensitive.
    check('users_email_normalized', sql`${t.email} = lower(btrim(${t.email}))`),
    check('users_failed_login_count_nonnegative', sql`${t.failedLoginCount} >= 0`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    // HMAC of the cookie token; the token itself is never stored.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // No password or Entra ID subject: a service account can never sign in to the web UI.
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('service_accounts_name_key').on(sql`lower(${t.name})`)],
);

const scopeList = sql.raw(TOKEN_SCOPES.map((s) => `'${s}'`).join(', '));

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceAccountId: uuid('service_account_id')
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: 'cascade' }),
    // The `<token id>` in `oitsm_<token id>_<secret>`; finds the row without scanning hashes.
    publicId: text('public_id').notNull(),
    // SHA-256 of the secret, hex. The secret itself is never stored.
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_tokens_public_id_key').on(t.publicId),
    uniqueIndex('api_tokens_secret_hash_key').on(t.secretHash),
    index('api_tokens_service_account_id_idx').on(t.serviceAccountId),
    check(
      'api_tokens_scopes_valid',
      sql`cardinality(${t.scopes}) > 0 and ${t.scopes} <@ array[${scopeList}]::text[]`,
    ),
    check(
      'api_tokens_expiry_within_a_year',
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '1 year'`,
    ),
  ],
);

export const assetTypes = pgTable(
  'asset_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    nextNumber: integer('next_number').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('asset_types_name_key').on(sql`lower(${t.name})`),
    uniqueIndex('asset_types_prefix_key').on(t.prefix),
    check('asset_types_prefix_format', sql`${t.prefix} ~ '^[A-Z0-9]{1,10}$'`),
    check('asset_types_next_number_positive', sql`${t.nextNumber} >= 1`),
  ],
);

export const assetTypeFields = pgTable(
  'asset_type_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetTypeId: uuid('asset_type_id')
      .notNull()
      .references(() => assetTypes.id, { onDelete: 'cascade' }),
    // Stable key for the JSONB values; derived from the first label and never changed.
    key: text('key').notNull(),
    label: text('label').notNull(),
    kind: fieldKind('kind').notNull(),
    options: text('options')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    required: boolean('required').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('asset_type_fields_type_key').on(t.assetTypeId, t.key),
    check('asset_type_fields_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check(
      'asset_type_fields_select_has_options',
      sql`${t.kind} <> 'select' or cardinality(${t.options}) > 0`,
    ),
  ],
);

/** Exactly one of a user and a service account made the change, or neither (system). */
function oneActor(name: string, userId: unknown, serviceAccountId: unknown) {
  return check(name, sql`${userId} is null or ${serviceAccountId} is null`);
}

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: text('number').notNull(),
    assetTypeId: uuid('asset_type_id')
      .notNull()
      .references(() => assetTypes.id),
    name: text('name').notNull(),
    status: assetStatus('status').notNull().default('in_stock'),
    fields: jsonb('fields')
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
    updatedByServiceAccountId: uuid('updated_by_service_account_id').references(
      () => serviceAccounts.id,
    ),
  },
  (t) => [
    // Unique across every type, ignoring case: the source of truth for duplicate numbers.
    uniqueIndex('assets_number_key').on(sql`lower(${t.number})`),
    index('assets_asset_type_id_idx').on(t.assetTypeId),
    index('assets_status_idx').on(t.status),
    check('assets_number_not_blank', sql`btrim(${t.number}) <> ''`),
    check('assets_fields_object', sql`jsonb_typeof(${t.fields}) = 'object'`),
    oneActor('assets_one_updater', t.updatedByUserId, t.updatedByServiceAccountId),
  ],
);

/**
 * Who had an asset or where it was. Append only (a trigger allows only ending an open row), and
 * at most one open assignment per asset.
 */
export const assetAssignments = pgTable(
  'asset_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    assignee: text('assignee').notNull().default(''),
    location: text('location').notNull().default(''),
    notes: text('notes').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    startedByUserId: uuid('started_by_user_id').references(() => users.id),
    startedByServiceAccountId: uuid('started_by_service_account_id').references(
      () => serviceAccounts.id,
    ),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByUserId: uuid('ended_by_user_id').references(() => users.id),
    endedByServiceAccountId: uuid('ended_by_service_account_id').references(
      () => serviceAccounts.id,
    ),
  },
  (t) => [
    index('asset_assignments_asset_id_idx').on(t.assetId, t.startedAt),
    uniqueIndex('asset_assignments_one_open')
      .on(t.assetId)
      .where(sql`${t.endedAt} is null`),
    check(
      'asset_assignments_who_or_where',
      sql`btrim(${t.assignee}) <> '' or btrim(${t.location}) <> ''`,
    ),
    check(
      'asset_assignments_ends_after_start',
      sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`,
    ),
    oneActor('asset_assignments_one_starter', t.startedByUserId, t.startedByServiceAccountId),
    oneActor('asset_assignments_one_ender', t.endedByUserId, t.endedByServiceAccountId),
  ],
);

/**
 * Repairs logged against an asset. Inserting one sets the asset to in repair (trigger);
 * `previousStatus` is what closing it restores. At most one open repair per asset.
 */
export const repairs = pgTable(
  'repairs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    summary: text('summary').notNull(),
    notes: text('notes').notNull().default(''),
    previousStatus: assetStatus('previous_status').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    openedByUserId: uuid('opened_by_user_id').references(() => users.id),
    openedByServiceAccountId: uuid('opened_by_service_account_id').references(
      () => serviceAccounts.id,
    ),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id),
    closedByServiceAccountId: uuid('closed_by_service_account_id').references(
      () => serviceAccounts.id,
    ),
  },
  (t) => [
    index('repairs_asset_id_idx').on(t.assetId, t.openedAt),
    uniqueIndex('repairs_one_open')
      .on(t.assetId)
      .where(sql`${t.closedAt} is null`),
    check('repairs_summary_not_blank', sql`btrim(${t.summary}) <> ''`),
    check(
      'repairs_closes_after_open',
      sql`${t.closedAt} is null or ${t.closedAt} >= ${t.openedAt}`,
    ),
    check('repairs_previous_status', sql`${t.previousStatus} not in ('in_repair', 'retired')`),
    oneActor('repairs_one_opener', t.openedByUserId, t.openedByServiceAccountId),
    oneActor('repairs_one_closer', t.closedByUserId, t.closedByServiceAccountId),
  ],
);

/**
 * The asset page's activity feed. Append only, except that deleting an asset (allowed only while
 * it has nothing but edits) removes its rows.
 */
export const assetEvents = pgTable(
  'asset_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    kind: assetEventKind('kind').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorServiceAccountId: uuid('actor_service_account_id').references(() => serviceAccounts.id),
    fromStatus: assetStatus('from_status'),
    toStatus: assetStatus('to_status'),
    subject: text('subject').notNull().default(''),
  },
  (t) => [
    index('asset_events_asset_id_idx').on(t.assetId, t.at),
    oneActor('asset_events_one_actor', t.actorUserId, t.actorServiceAccountId),
  ],
);

/**
 * Parts and supplies counted by quantity. The quantity never goes below zero and changes only
 * through `consumable_adjustments` (a trigger applies each adjustment), so it always matches its
 * history.
 */
export const consumables = pgTable(
  'consumables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('consumables_name_key').on(sql`lower(${t.name})`),
    check('consumables_name_not_blank', sql`btrim(${t.name}) <> ''`),
    check('consumables_quantity_not_negative', sql`${t.quantity} >= 0`),
    check('consumables_threshold_not_negative', sql`${t.lowStockThreshold} >= 0`),
  ],
);

/**
 * Every change to a consumable's quantity, with who made it and why. Append only, except that
 * deleting a consumable (allowed only while it has nothing but its starting stock) removes its
 * rows. `quantity_after` is set by the trigger that applies the change.
 */
export const consumableAdjustments = pgTable(
  'consumable_adjustments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    consumableId: uuid('consumable_id')
      .notNull()
      .references(() => consumables.id, { onDelete: 'cascade' }),
    kind: consumableAdjustmentKind('kind').notNull(),
    change: integer('change').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    reason: text('reason').notNull().default(''),
    repairId: uuid('repair_id').references(() => repairs.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorServiceAccountId: uuid('actor_service_account_id').references(() => serviceAccounts.id),
  },
  (t) => [
    index('consumable_adjustments_consumable_id_idx').on(t.consumableId, t.at),
    index('consumable_adjustments_repair_id_idx')
      .on(t.repairId)
      .where(sql`${t.repairId} is not null`),
    check('consumable_adjustments_quantity_after', sql`${t.quantityAfter} >= 0`),
    check(
      'consumable_adjustments_change_sign',
      sql`(${t.kind} = 'added' and ${t.change} > 0) or (${t.kind} = 'used' and ${t.change} < 0) or ${t.kind} in ('created', 'counted')`,
    ),
    check(
      'consumable_adjustments_repair_only_used',
      sql`${t.repairId} is null or ${t.kind} = 'used'`,
    ),
    oneActor('consumable_adjustments_one_actor', t.actorUserId, t.actorServiceAccountId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorServiceAccountId: uuid('actor_service_account_id').references(() => serviceAccounts.id),
    action: text('action').notNull(),
    targetUserId: uuid('target_user_id').references(() => users.id),
    ip: text('ip'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    oneActor('audit_log_one_actor', t.actorUserId, t.actorServiceAccountId),
  ],
);
