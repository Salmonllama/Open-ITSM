-- A consumable's quantity changes only through an adjustment row, which this trigger applies.
-- The check on consumables.quantity then refuses any change that would take stock below zero,
-- whoever writes it.
CREATE FUNCTION "consumable_adjustments_apply"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE consumables SET quantity = quantity + NEW.change, updated_at = now()
		WHERE id = NEW.consumable_id
		RETURNING quantity INTO NEW.quantity_after;
	IF NOT FOUND THEN
		RAISE foreign_key_violation USING MESSAGE = 'consumable does not exist';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "consumable_adjustments_apply" BEFORE INSERT ON "consumable_adjustments"
	FOR EACH ROW EXECUTE FUNCTION "consumable_adjustments_apply"();--> statement-breakpoint
-- Direct writes to the quantity are refused; only the trigger above (one level down) may set it.
CREATE FUNCTION "consumables_quantity_from_adjustments"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF pg_trigger_depth() = 1 AND (
		(TG_OP = 'INSERT' AND NEW.quantity <> 0)
		OR (TG_OP = 'UPDATE' AND NEW.quantity IS DISTINCT FROM OLD.quantity)
	) THEN
		RAISE EXCEPTION 'consumables.quantity changes only through consumable_adjustments';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "consumables_quantity" BEFORE INSERT OR UPDATE ON "consumables"
	FOR EACH ROW EXECUTE FUNCTION "consumables_quantity_from_adjustments"();--> statement-breakpoint
-- Adjustments are append only; they are deleted only by the cascade when their consumable is
-- deleted, which the API allows only while it has nothing but its starting stock.
CREATE FUNCTION "consumable_adjustments_only_cascade"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM consumables WHERE id = OLD.consumable_id) THEN
		RAISE EXCEPTION 'consumable_adjustments is append only';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "consumable_adjustments_no_update" BEFORE UPDATE ON "consumable_adjustments"
	FOR EACH ROW EXECUTE FUNCTION "asset_history_reject_change"();--> statement-breakpoint
CREATE TRIGGER "consumable_adjustments_delete" BEFORE DELETE ON "consumable_adjustments"
	FOR EACH ROW EXECUTE FUNCTION "consumable_adjustments_only_cascade"();--> statement-breakpoint
CREATE TRIGGER "consumable_adjustments_no_truncate" BEFORE TRUNCATE ON "consumable_adjustments"
	FOR EACH STATEMENT EXECUTE FUNCTION "asset_history_reject_change"();
