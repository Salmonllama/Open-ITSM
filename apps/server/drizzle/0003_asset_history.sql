CREATE TYPE "public"."asset_event_kind" AS ENUM('edited', 'status_changed', 'assigned', 'returned', 'repair_opened', 'repair_closed');--> statement-breakpoint
CREATE TABLE "asset_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"assignee" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_by_user_id" uuid,
	"started_by_service_account_id" uuid,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"ended_by_service_account_id" uuid,
	CONSTRAINT "asset_assignments_who_or_where" CHECK (btrim("asset_assignments"."assignee") <> '' or btrim("asset_assignments"."location") <> ''),
	CONSTRAINT "asset_assignments_ends_after_start" CHECK ("asset_assignments"."ended_at" is null or "asset_assignments"."ended_at" >= "asset_assignments"."started_at"),
	CONSTRAINT "asset_assignments_one_starter" CHECK ("asset_assignments"."started_by_user_id" is null or "asset_assignments"."started_by_service_account_id" is null),
	CONSTRAINT "asset_assignments_one_ender" CHECK ("asset_assignments"."ended_by_user_id" is null or "asset_assignments"."ended_by_service_account_id" is null)
);
--> statement-breakpoint
CREATE TABLE "asset_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "asset_event_kind" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_service_account_id" uuid,
	"from_status" "asset_status",
	"to_status" "asset_status",
	"subject" text DEFAULT '' NOT NULL,
	CONSTRAINT "asset_events_one_actor" CHECK ("asset_events"."actor_user_id" is null or "asset_events"."actor_service_account_id" is null)
);
--> statement-breakpoint
CREATE TABLE "repairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"previous_status" "asset_status" NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by_user_id" uuid,
	"opened_by_service_account_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"closed_by_service_account_id" uuid,
	CONSTRAINT "repairs_summary_not_blank" CHECK (btrim("repairs"."summary") <> ''),
	CONSTRAINT "repairs_closes_after_open" CHECK ("repairs"."closed_at" is null or "repairs"."closed_at" >= "repairs"."opened_at"),
	CONSTRAINT "repairs_previous_status" CHECK ("repairs"."previous_status" not in ('in_repair', 'retired')),
	CONSTRAINT "repairs_one_opener" CHECK ("repairs"."opened_by_user_id" is null or "repairs"."opened_by_service_account_id" is null),
	CONSTRAINT "repairs_one_closer" CHECK ("repairs"."closed_by_user_id" is null or "repairs"."closed_by_service_account_id" is null)
);
--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_started_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("started_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_ended_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("ended_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_actor_service_account_id_service_accounts_id_fk" FOREIGN KEY ("actor_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_opened_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("opened_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repairs" ADD CONSTRAINT "repairs_closed_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("closed_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_assignments_asset_id_idx" ON "asset_assignments" USING btree ("asset_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_assignments_one_open" ON "asset_assignments" USING btree ("asset_id") WHERE "asset_assignments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "asset_events_asset_id_idx" ON "asset_events" USING btree ("asset_id","at");--> statement-breakpoint
CREATE INDEX "repairs_asset_id_idx" ON "repairs" USING btree ("asset_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repairs_one_open" ON "repairs" USING btree ("asset_id") WHERE "repairs"."closed_at" is null;