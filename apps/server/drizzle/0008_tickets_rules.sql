-- Ticket history is append only, whoever writes it. The only change allowed to a message is
-- recording, once, when a reply was emailed (M7).
CREATE FUNCTION "ticket_messages_only_emailed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.emailed_at IS NOT NULL OR NEW.emailed_at IS NULL
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
CREATE TRIGGER "ticket_messages_update" BEFORE UPDATE ON "ticket_messages"
	FOR EACH ROW EXECUTE FUNCTION "ticket_messages_only_emailed"();--> statement-breakpoint
CREATE TRIGGER "ticket_messages_no_delete" BEFORE DELETE ON "ticket_messages"
	FOR EACH ROW EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "ticket_messages_no_truncate" BEFORE TRUNCATE ON "ticket_messages"
	FOR EACH STATEMENT EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "ticket_events_no_update" BEFORE UPDATE OR DELETE ON "ticket_events"
	FOR EACH ROW EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "ticket_events_no_truncate" BEFORE TRUNCATE ON "ticket_events"
	FOR EACH STATEMENT EXECUTE FUNCTION "asset_history_reject_change"();
