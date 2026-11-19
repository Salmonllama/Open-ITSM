CREATE TYPE "public"."channel_kind" AS ENUM('slack', 'teams');--> statement-breakpoint
CREATE TYPE "public"."low_stock_mode" AS ENUM('first', 'every');--> statement-breakpoint
CREATE TYPE "public"."notification_event" AS ENUM('ticket_created', 'ticket_assigned', 'low_stock');--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"webhook_url" text NOT NULL,
	"webhook_hint" text NOT NULL,
	"events" "notification_event"[] DEFAULT '{}' NOT NULL,
	"low_stock_mode" "low_stock_mode" DEFAULT 'first' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_name_key" ON "notification_channels" USING btree (lower("name"));