CREATE TYPE "public"."asset_status" AS ENUM('preparing', 'in_stock', 'deployed', 'in_repair', 'retired');--> statement-breakpoint
CREATE TYPE "public"."field_kind" AS ENUM('text', 'number', 'date', 'select', 'boolean');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"public_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_scopes_valid" CHECK (cardinality("api_tokens"."scopes") > 0 and "api_tokens"."scopes" <@ array['assets:read', 'assets:write', 'tickets:read', 'tickets:write']::text[]),
	CONSTRAINT "api_tokens_expiry_within_a_year" CHECK ("api_tokens"."expires_at" > "api_tokens"."created_at" and "api_tokens"."expires_at" <= "api_tokens"."created_at" + interval '1 year')
);
--> statement-breakpoint
CREATE TABLE "asset_type_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" "field_kind" NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_type_fields_key_format" CHECK ("asset_type_fields"."key" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "asset_type_fields_select_has_options" CHECK ("asset_type_fields"."kind" <> 'select' or cardinality("asset_type_fields"."options") > 0)
);
--> statement-breakpoint
CREATE TABLE "asset_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_types_prefix_format" CHECK ("asset_types"."prefix" ~ '^[A-Z0-9]{1,10}$'),
	CONSTRAINT "asset_types_next_number_positive" CHECK ("asset_types"."next_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "asset_status" DEFAULT 'in_stock' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"updated_by_service_account_id" uuid,
	CONSTRAINT "assets_number_not_blank" CHECK (btrim("assets"."number") <> ''),
	CONSTRAINT "assets_fields_object" CHECK (jsonb_typeof("assets"."fields") = 'object'),
	CONSTRAINT "assets_one_updater" CHECK ("assets"."updated_by_user_id" is null or "assets"."updated_by_service_account_id" is null)
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_type_fields" ADD CONSTRAINT "asset_type_fields_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "public"."asset_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "public"."asset_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_updated_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("updated_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_public_id_key" ON "api_tokens" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_secret_hash_key" ON "api_tokens" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_service_account_id_idx" ON "api_tokens" USING btree ("service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_type_fields_type_key" ON "asset_type_fields" USING btree ("asset_type_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_types_name_key" ON "asset_types" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "asset_types_prefix_key" ON "asset_types" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_number_key" ON "assets" USING btree (lower("number"));--> statement-breakpoint
CREATE INDEX "assets_asset_type_id_idx" ON "assets" USING btree ("asset_type_id");--> statement-breakpoint
CREATE INDEX "assets_status_idx" ON "assets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "service_accounts_name_key" ON "service_accounts" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_service_account_id_service_accounts_id_fk" FOREIGN KEY ("actor_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_one_actor" CHECK ("audit_log"."actor_user_id" is null or "audit_log"."actor_service_account_id" is null);