-- What a service needs to decide whether it may run against this database, readable by every
-- role (worker and tool runner roles included) without access to the migration table: the
-- applied migration hashes in order, the pg-boss schema version, and the releases certified
-- for exactly this schema. plpgsql: the pg-boss schema does not exist yet when this migration
-- runs on a fresh database.
CREATE FUNCTION gateway_schema_state()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
	v_hashes text[];
	v_pgboss integer;
	v_fingerprint text;
BEGIN
	SELECT coalesce(array_agg(hash ORDER BY id), '{}') INTO v_hashes
	  FROM drizzle.__drizzle_migrations;
	IF to_regclass('pgboss.version') IS NOT NULL THEN
		EXECUTE 'SELECT version FROM pgboss.version' INTO v_pgboss;
	END IF;
	v_fingerprint := encode(sha256(convert_to(
		array_to_string(v_hashes, E'\n') || E'\npgboss:' || coalesce(v_pgboss::text, 'none'),
		'UTF8')), 'hex');
	RETURN jsonb_build_object(
		'hashes', to_jsonb(v_hashes),
		'pgboss_schema', v_pgboss,
		'certified', coalesce((
			SELECT jsonb_agg(c.release ORDER BY c.release)
			  FROM public.schema_certifications c
			 WHERE c.fingerprint = v_fingerprint
		), '[]'::jsonb)
	);
END;
$$;
--> statement-breakpoint
-- Every role may call it: it returns only migration hashes and version numbers.
GRANT EXECUTE ON FUNCTION gateway_schema_state() TO PUBLIC;
