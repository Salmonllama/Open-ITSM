CREATE TABLE "login_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	CONSTRAINT "login_links_email_normalized" CHECK ("login_links"."email" = lower(btrim("login_links"."email")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "login_links_token_hash_key" ON "login_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "login_links_email_created_idx" ON "login_links" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "login_links_expires_at_idx" ON "login_links" USING btree ("expires_at");