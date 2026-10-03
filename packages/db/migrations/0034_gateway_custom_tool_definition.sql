-- The tool runner's one window into a `custom_https` entry's content (ADR-027), symmetrical with
-- `gateway_begin_tool_action` (migration 0011): a narrow, read-only `SECURITY DEFINER` function,
-- never a table grant. It returns exactly one immutable version's own definition, by (entry id,
-- version) — never the entry's *current* state, so an edit after an approval was granted can never
-- change what the runner actually sends; the grant-time policy check is what refuses a request
-- whose pinned version has fallen behind the entry's current one. No row for a missing entry or
-- version, a kind other than `custom_https`, or an entry deleted since (defense in depth: a
-- deleted entry's queued actions are already revoked before this would ever run).
--
-- Cross-namespace denial: only a role that can settle the `custom` namespace's own execute jobs
-- (granted by `gateway db grant-tool-runner`, the same check `gateway_begin_tool_action` makes for
-- its own namespace) may read a definition at all — a runner of another namespace (`mail`,
-- `finance`, ...) gets no row, exactly as it gets `wrong_namespace` from `begin`.
CREATE FUNCTION gateway_custom_tool_definition(p_entry_id text, p_version integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	v_queue_table text;
	v_definition jsonb;
BEGIN
	SELECT table_name INTO v_queue_table FROM pgboss.queue WHERE name = 'tool.execute.custom';
	IF v_queue_table IS NULL
		OR NOT has_table_privilege(session_user, format('pgboss.%I', v_queue_table), 'UPDATE') THEN
		RETURN NULL;
	END IF;
	SELECT v.https_definition INTO v_definition
	  FROM catalog_entry_versions v
	  JOIN catalog_entries e ON e.id = v.entry_id
	 WHERE v.entry_id = p_entry_id
	   AND v.version = p_version
	   AND v.kind = 'custom_https'
	   AND e.deleted_at IS NULL;
	RETURN v_definition;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION gateway_custom_tool_definition(text, integer) FROM PUBLIC;
