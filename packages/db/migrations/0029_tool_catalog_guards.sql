-- A catalog entry's own version history is append-only: everything about what a version
-- contained is immutable once written. Deleting the entry itself (catalog_entries) never touches
-- its past versions, which this trigger keeps exactly as recorded regardless.
CREATE FUNCTION catalog_entry_versions_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'catalog_entry_versions is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_entry_versions_append_only
	BEFORE UPDATE OR DELETE OR TRUNCATE ON catalog_entry_versions
	FOR EACH STATEMENT EXECUTE FUNCTION catalog_entry_versions_reject_change();
