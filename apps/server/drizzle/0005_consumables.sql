CREATE TYPE "public"."consumable_adjustment_kind" AS ENUM('created', 'added', 'used', 'counted');--> statement-breakpoint
CREATE TABLE "consumable_adjustments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"consumable_id" uuid NOT NULL,
	"kind" "consumable_adjustment_kind" NOT NULL,
	"change" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"repair_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_service_account_id" uuid,
	CONSTRAINT "consumable_adjustments_quantity_after" CHECK ("consumable_adjustments"."quantity_after" >= 0),
	CONSTRAINT "consumable_adjustments_change_sign" CHECK (("consumable_adjustments"."kind" = 'added' and "consumable_adjustments"."change" > 0) or ("consumable_adjustments"."kind" = 'used' and "consumable_adjustments"."change" < 0) or "consumable_adjustments"."kind" in ('created', 'counted')),
	CONSTRAINT "consumable_adjustments_repair_only_used" CHECK ("consumable_adjustments"."repair_id" is null or "consumable_adjustments"."kind" = 'used'),
	CONSTRAINT "consumable_adjustments_one_actor" CHECK ("consumable_adjustments"."actor_user_id" is null or "consumable_adjustments"."actor_service_account_id" is null)
);
--> statement-breakpoint
CREATE TABLE "consumables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumables_name_not_blank" CHECK (btrim("consumables"."name") <> ''),
	CONSTRAINT "consumables_quantity_not_negative" CHECK ("consumables"."quantity" >= 0),
	CONSTRAINT "consumables_threshold_not_negative" CHECK ("consumables"."low_stock_threshold" >= 0)
);
--> statement-breakpoint
ALTER TABLE "consumable_adjustments" ADD CONSTRAINT "consumable_adjustments_consumable_id_consumables_id_fk" FOREIGN KEY ("consumable_id") REFERENCES "public"."consumables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_adjustments" ADD CONSTRAINT "consumable_adjustments_repair_id_repairs_id_fk" FOREIGN KEY ("repair_id") REFERENCES "public"."repairs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_adjustments" ADD CONSTRAINT "consumable_adjustments_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_adjustments" ADD CONSTRAINT "consumable_adjustments_actor_service_account_id_service_accounts_id_fk" FOREIGN KEY ("actor_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consumable_adjustments_consumable_id_idx" ON "consumable_adjustments" USING btree ("consumable_id","at");--> statement-breakpoint
CREATE INDEX "consumable_adjustments_repair_id_idx" ON "consumable_adjustments" USING btree ("repair_id") WHERE "consumable_adjustments"."repair_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "consumables_name_key" ON "consumables" USING btree (lower("name"));