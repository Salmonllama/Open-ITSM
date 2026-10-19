import { ASSET_STATUSES, FIELD_KINDS, TOKEN_SCOPES } from '@open-itsm/shared';
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
