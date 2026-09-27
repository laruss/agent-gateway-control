-- An approval request is immutable once stored: what a human approves is exactly what was
-- hashed. Only the decision may be written, once, and a status leaves 'pending' at most once.
CREATE FUNCTION approval_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'approval requests are never deleted';
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.requested_by_agent_id IS DISTINCT FROM OLD.requested_by_agent_id
		OR NEW.run_id IS DISTINCT FROM OLD.run_id
		OR NEW.action_type IS DISTINCT FROM OLD.action_type
		OR NEW.action_params IS DISTINCT FROM OLD.action_params
		OR NEW.immutable_action_hash IS DISTINCT FROM OLD.immutable_action_hash
		OR NEW.action_summary IS DISTINCT FROM OLD.action_summary
		OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
		OR NEW.allowed_approver_user_ids IS DISTINCT FROM OLD.allowed_approver_user_ids
		OR NEW.nonce IS DISTINCT FROM OLD.nonce
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
		RAISE EXCEPTION 'approval request % is immutable', OLD.id;
	END IF;
	IF (OLD.decided_by_user_id IS NOT NULL AND NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id)
		OR (OLD.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM OLD.decided_at)
		OR (OLD.decision_post_id IS NOT NULL AND NEW.decision_post_id IS DISTINCT FROM OLD.decision_post_id)
		OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at) THEN
		RAISE EXCEPTION 'the decision of approval request % is final', OLD.id;
	END IF;
	IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
		RAISE EXCEPTION 'approval request % is already %', OLD.id, OLD.status;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_requests_immutable
	BEFORE UPDATE OR DELETE ON approval_requests
	FOR EACH ROW EXECUTE FUNCTION approval_requests_guard();
--> statement-breakpoint
-- A tool action carries the approved action unchanged, and moves only forward:
-- queued -> running | failed | cancelled; running -> succeeded | failed | unknown;
-- unknown -> succeeded | failed | cancelled (an operator's or a late runner's word).
CREATE FUNCTION tool_actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'tool actions are never deleted';
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
		OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
		OR NEW.namespace IS DISTINCT FROM OLD.namespace
		OR NEW.action_type IS DISTINCT FROM OLD.action_type
		OR NEW.action_params IS DISTINCT FROM OLD.action_params
		OR NEW.immutable_action_hash IS DISTINCT FROM OLD.immutable_action_hash
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.config_version IS DISTINCT FROM OLD.config_version
		OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'tool action % is immutable', OLD.id;
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled'))
		OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'unknown'))
		OR (OLD.status = 'unknown' AND NEW.status IN ('succeeded', 'failed', 'cancelled'))
	) THEN
		RAISE EXCEPTION 'tool action % cannot go from % to %', OLD.id, OLD.status, NEW.status;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tool_actions_forward_only
	BEFORE UPDATE OR DELETE ON tool_actions
	FOR EACH ROW EXECUTE FUNCTION tool_actions_guard();
--> statement-breakpoint
-- The tool runner's door into domain state: the last check before an executor runs. It takes
-- the controls row in share mode (kill-all takes it exclusively) and the action's row, so either
-- kill-all comes first and nothing runs, or this does and kill-all sees a running action.
-- Returns 'begin' and the action's idempotency key (the stored one, never the job's), or why
-- not.
CREATE FUNCTION gateway_begin_tool_action(p_action_id uuid, p_attempt integer, p_hash text)
RETURNS TABLE (verdict text, idempotency_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	v_kill boolean;
	v_action tool_actions%ROWTYPE;
	v_approval text;
	v_enabled boolean;
	v_queue_table text;
BEGIN
	SELECT kill_switch INTO v_kill FROM gateway_controls WHERE id = 1 FOR SHARE;
	SELECT * INTO v_action FROM tool_actions WHERE id = p_action_id FOR UPDATE;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'unknown_action'::text, NULL::text;
		RETURN;
	END IF;
	-- A runner begins only actions of a namespace it serves: its role must be able to settle
	-- that namespace's execute jobs (granted by `gateway db grant-tool-runner`).
	SELECT table_name INTO v_queue_table FROM pgboss.queue
	 WHERE name = 'tool.execute.' || v_action.namespace;
	IF v_queue_table IS NULL
		OR NOT has_table_privilege(session_user, format('pgboss.%I', v_queue_table), 'UPDATE') THEN
		RETURN QUERY SELECT 'wrong_namespace'::text, NULL::text;
		RETURN;
	END IF;
	IF v_kill IS DISTINCT FROM false THEN
		RETURN QUERY SELECT 'kill_switch'::text, NULL::text;
		RETURN;
	END IF;
	IF v_action.status <> 'queued' THEN
		RETURN QUERY SELECT 'not_queued'::text, NULL::text;
		RETURN;
	END IF;
	IF v_action.attempt <> p_attempt THEN
		RETURN QUERY SELECT 'stale_attempt'::text, NULL::text;
		RETURN;
	END IF;
	IF v_action.immutable_action_hash <> p_hash THEN
		RETURN QUERY SELECT 'hash_mismatch'::text, NULL::text;
		RETURN;
	END IF;
	IF v_action.cancel_requested_at IS NOT NULL THEN
		RETURN QUERY SELECT 'cancel_requested'::text, NULL::text;
		RETURN;
	END IF;
	IF v_action.deadline_at <= now() THEN
		RETURN QUERY SELECT 'deadline_passed'::text, NULL::text;
		RETURN;
	END IF;
	SELECT status INTO v_approval FROM approval_requests WHERE id = v_action.approval_id;
	IF v_approval IS DISTINCT FROM 'granted' THEN
		RETURN QUERY SELECT 'not_granted'::text, NULL::text;
		RETURN;
	END IF;
	SELECT enabled INTO v_enabled FROM agents WHERE id = v_action.agent_id;
	IF v_enabled IS DISTINCT FROM true THEN
		RETURN QUERY SELECT 'agent_disabled'::text, NULL::text;
		RETURN;
	END IF;
	UPDATE tool_actions SET status = 'running', started_at = now() WHERE id = p_action_id;
	RETURN QUERY SELECT 'begin'::text, v_action.idempotency_key;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION gateway_begin_tool_action(uuid, integer, text) FROM PUBLIC;
--> statement-breakpoint
-- Whether a running action was asked to stop (kill-all, the agent disabled): the runner polls it
-- while an executor works and aborts the executor's call.
CREATE FUNCTION gateway_tool_action_stop_requested(p_action_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT coalesce(
		(SELECT cancel_requested_at IS NOT NULL FROM tool_actions WHERE id = p_action_id), true
	) OR coalesce((SELECT kill_switch FROM gateway_controls WHERE id = 1), true);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION gateway_tool_action_stop_requested(uuid) FROM PUBLIC;
