-- config_attachment_snapshots is append-only, the same guard config_snapshots already has
-- (migration 0019): history must not be rewritten.
CREATE FUNCTION config_attachment_snapshots_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'config_attachment_snapshots is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER config_attachment_snapshots_append_only
	BEFORE UPDATE OR DELETE OR TRUNCATE ON config_attachment_snapshots
	FOR EACH STATEMENT EXECUTE FUNCTION config_attachment_snapshots_reject_change();
