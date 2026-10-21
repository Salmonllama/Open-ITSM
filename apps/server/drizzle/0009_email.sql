CREATE TYPE "public"."email_status" AS ENUM('not_sent', 'queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ticket_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"message_id" bigint,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text,
	"sha256" text,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_service_account_id" uuid,
	CONSTRAINT "ticket_attachments_size" CHECK ("ticket_attachments"."size" >= 0),
	CONSTRAINT "ticket_attachments_kept_or_skipped" CHECK (("ticket_attachments"."storage_key" is null) = ("ticket_attachments"."skipped_reason" is not null)),
	CONSTRAINT "ticket_attachments_one_actor" CHECK ("ticket_attachments"."actor_user_id" is null or "ticket_attachments"."actor_service_account_id" is null)
);
--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "internet_message_id" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "email_status" "email_status";--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "email_error" text;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_actor_service_account_id_service_accounts_id_fk" FOREIGN KEY ("actor_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_attachments_message_id_idx" ON "ticket_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ticket_attachments_pending_idx" ON "ticket_attachments" USING btree ("created_at") WHERE "ticket_attachments"."message_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_inbound_internet_id_key" ON "ticket_messages" USING btree ("internet_message_id") WHERE "ticket_messages"."kind" = 'inbound';--> statement-breakpoint
CREATE INDEX "ticket_messages_internet_message_id_idx" ON "ticket_messages" USING btree ("internet_message_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_conversation_id_idx" ON "ticket_messages" USING btree ("conversation_id");--> statement-breakpoint
-- Replies saved before a mailbox could be connected were never emailed, and never will be.
ALTER TABLE "ticket_messages" DISABLE TRIGGER "ticket_messages_update";--> statement-breakpoint
UPDATE "ticket_messages" SET "email_status" = 'not_sent' WHERE "kind" = 'reply';--> statement-breakpoint
ALTER TABLE "ticket_messages" ENABLE TRIGGER "ticket_messages_update";--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_email_status_on_replies" CHECK (("ticket_messages"."kind" = 'reply') = ("ticket_messages"."email_status" is not null));