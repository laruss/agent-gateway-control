CREATE TABLE "schema_certifications" (
	"release" text NOT NULL,
	"fingerprint" text NOT NULL,
	"certified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_certifications_release_fingerprint_pk" PRIMARY KEY("release","fingerprint")
);
--> statement-breakpoint
-- What a service needs to decide whether it may run against this database, readable by the
-- worker and tool runner roles without access to the migration table: the applied migration
-- hashes in order, and the releases certified for exactly this history.
CREATE FUNCTION gateway_schema_state()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
	WITH applied AS (
		SELECT coalesce(array_agg(hash ORDER BY id), '{}') AS hashes
		  FROM drizzle.__drizzle_migrations
	), current AS (
		SELECT encode(sha256(convert_to(array_to_string(hashes, E'\n'), 'UTF8')), 'hex') AS fingerprint
		  FROM applied
	)
	SELECT jsonb_build_object(
		'hashes', to_jsonb((SELECT hashes FROM applied)),
		'certified', coalesce((
			SELECT jsonb_agg(c.release ORDER BY c.release)
			  FROM public.schema_certifications c, current
			 WHERE c.fingerprint = current.fingerprint
		), '[]'::jsonb)
	);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION gateway_schema_state() FROM PUBLIC;
