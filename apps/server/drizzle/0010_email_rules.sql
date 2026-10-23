-- Sending a reply records how it went: its email status and error, when it was sent, and the
-- sent email's IDs for threading. Nothing else about a message ever changes, and a reply that
-- was sent stays sent.
CREATE OR REPLACE FUNCTION "ticket_messages_only_emailed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.kind <> 'reply' OR OLD.emailed_at IS NOT NULL OR OLD.email_status = 'sent'
		OR (NEW.id, NEW.ticket_id, NEW.kind, NEW.body, NEW.from_name, NEW.from_email,
			NEW.graph_message_id, NEW.at, NEW.actor_user_id, NEW.actor_service_account_id)
			IS DISTINCT FROM
			(OLD.id, OLD.ticket_id, OLD.kind, OLD.body, OLD.from_name, OLD.from_email,
			OLD.graph_message_id, OLD.at, OLD.actor_user_id, OLD.actor_service_account_id)
	THEN
		RAISE EXCEPTION 'ticket_messages is append only';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
-- Attachments are kept for good once they belong to a message. An upload waiting for its
-- message can be joined to one message, once, or deleted.
CREATE FUNCTION "ticket_attachments_only_attach"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.message_id IS NOT NULL THEN
			RAISE EXCEPTION 'ticket_attachments is append only';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD.message_id IS NOT NULL OR NEW.message_id IS NULL
		OR (NEW.id, NEW.ticket_id, NEW.name, NEW.content_type, NEW.size, NEW.storage_key,
			NEW.sha256, NEW.skipped_reason, NEW.created_at, NEW.actor_user_id,
			NEW.actor_service_account_id)
			IS DISTINCT FROM
			(OLD.id, OLD.ticket_id, OLD.name, OLD.content_type, OLD.size, OLD.storage_key,
			OLD.sha256, OLD.skipped_reason, OLD.created_at, OLD.actor_user_id,
			OLD.actor_service_account_id)
	THEN
		RAISE EXCEPTION 'ticket_attachments is append only';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ticket_attachments_change" BEFORE UPDATE OR DELETE ON "ticket_attachments"
	FOR EACH ROW EXECUTE FUNCTION "ticket_attachments_only_attach"();--> statement-breakpoint
CREATE TRIGGER "ticket_attachments_no_truncate" BEFORE TRUNCATE ON "ticket_attachments"
	FOR EACH STATEMENT EXECUTE FUNCTION "asset_history_reject_change"();
