-- Asset history is append only. Assignments and repairs may only be ended or closed once, and
-- never deleted. Asset events never change; they are deleted only by the cascade when their
-- asset is deleted, which the API allows only while the asset has nothing but edits.
CREATE FUNCTION "asset_history_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append only', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "asset_assignments_only_end"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
		OR (NEW.id, NEW.asset_id, NEW.assignee, NEW.location, NEW.notes, NEW.started_at,
			NEW.started_by_user_id, NEW.started_by_service_account_id)
		IS DISTINCT FROM (OLD.id, OLD.asset_id, OLD.assignee, OLD.location, OLD.notes, OLD.started_at,
			OLD.started_by_user_id, OLD.started_by_service_account_id)
	THEN
		RAISE EXCEPTION 'asset_assignments is append only: an open assignment can only be ended';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "repairs_only_close"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Closing may also replace the notes, to record the outcome.
	IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
		OR (NEW.id, NEW.asset_id, NEW.summary, NEW.previous_status, NEW.opened_at,
			NEW.opened_by_user_id, NEW.opened_by_service_account_id)
		IS DISTINCT FROM (OLD.id, OLD.asset_id, OLD.summary, OLD.previous_status, OLD.opened_at,
			OLD.opened_by_user_id, OLD.opened_by_service_account_id)
	THEN
		RAISE EXCEPTION 'repairs is append only: an open repair can only be closed';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
-- Opening a repair moves the asset to in repair, whoever inserts the row.
CREATE FUNCTION "repairs_set_in_repair"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE assets SET status = 'in_repair' WHERE id = NEW.asset_id;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "asset_assignments_update" BEFORE UPDATE ON "asset_assignments"
	FOR EACH ROW EXECUTE FUNCTION "asset_assignments_only_end"();--> statement-breakpoint
CREATE TRIGGER "asset_assignments_no_delete" BEFORE DELETE ON "asset_assignments"
	FOR EACH ROW EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "asset_assignments_no_truncate" BEFORE TRUNCATE ON "asset_assignments"
	FOR EACH STATEMENT EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "repairs_update" BEFORE UPDATE ON "repairs"
	FOR EACH ROW EXECUTE FUNCTION "repairs_only_close"();--> statement-breakpoint
CREATE TRIGGER "repairs_no_delete" BEFORE DELETE ON "repairs"
	FOR EACH ROW EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "repairs_no_truncate" BEFORE TRUNCATE ON "repairs"
	FOR EACH STATEMENT EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "repairs_opened" AFTER INSERT ON "repairs"
	FOR EACH ROW EXECUTE FUNCTION "repairs_set_in_repair"();--> statement-breakpoint
CREATE FUNCTION "asset_events_only_cascade"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- The cascade from deleting the asset runs after the asset row is gone.
	IF EXISTS (SELECT 1 FROM assets WHERE id = OLD.asset_id) THEN
		RAISE EXCEPTION 'asset_events is append only';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "asset_events_no_update" BEFORE UPDATE ON "asset_events"
	FOR EACH ROW EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "asset_events_delete" BEFORE DELETE ON "asset_events"
	FOR EACH ROW EXECUTE FUNCTION "asset_events_only_cascade"();--> statement-breakpoint
CREATE TRIGGER "asset_events_no_truncate" BEFORE TRUNCATE ON "asset_events"
	FOR EACH STATEMENT EXECUTE FUNCTION "asset_history_reject_change"();
