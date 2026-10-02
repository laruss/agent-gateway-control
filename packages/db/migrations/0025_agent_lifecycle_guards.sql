-- An agent lifecycle operation is an append-only journal entry: everything about what was
-- requested is immutable once stored, and only the provisioner's own progress (state,
-- checkpoints, error) and its timestamps may still change, moving the state forward only.
CREATE FUNCTION agent_lifecycle_operations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'agent lifecycle operations are never deleted';
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
		OR NEW.kind IS DISTINCT FROM OLD.kind
		OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
		OR NEW.source IS DISTINCT FROM OLD.source
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.config_revision_id IS DISTINCT FROM OLD.config_revision_id
		OR NEW.generation IS DISTINCT FROM OLD.generation
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'agent lifecycle operation % is immutable', OLD.id;
	END IF;
	IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
		(OLD.state = 'pending' AND NEW.state IN ('running', 'succeeded', 'failed', 'cancelled'))
		OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed', 'cancelled'))
	) THEN
		RAISE EXCEPTION 'agent lifecycle operation % cannot go from % to %', OLD.id, OLD.state, NEW.state;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_lifecycle_operations_append_only
	BEFORE UPDATE OR DELETE ON agent_lifecycle_operations
	FOR EACH ROW EXECUTE FUNCTION agent_lifecycle_operations_guard();
