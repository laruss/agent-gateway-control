-- audit_log is append-only: security-relevant history must not be rewritten.
CREATE FUNCTION audit_log_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
	BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
	FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();
--> statement-breakpoint
-- The single row of global controls exists from the start.
INSERT INTO gateway_controls (id, kill_switch) VALUES (1, false) ON CONFLICT DO NOTHING;
