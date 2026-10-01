-- config_snapshots and config_revisions are append-only: history must not be rewritten.
CREATE FUNCTION config_snapshots_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'config_snapshots is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER config_snapshots_append_only
	BEFORE UPDATE OR DELETE OR TRUNCATE ON config_snapshots
	FOR EACH STATEMENT EXECUTE FUNCTION config_snapshots_reject_change();
--> statement-breakpoint
CREATE FUNCTION config_revisions_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'config_revisions is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER config_revisions_append_only
	BEFORE UPDATE OR DELETE OR TRUNCATE ON config_revisions
	FOR EACH STATEMENT EXECUTE FUNCTION config_revisions_reject_change();
