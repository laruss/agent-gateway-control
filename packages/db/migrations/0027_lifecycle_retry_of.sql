-- `requestOperationRetry` now records which `failed` operation its own fresh attempt retried
-- (`retry_of`): without it, a repeated idempotency key could not be told apart from one already
-- used for a `requestAgentCreate`/`requestAgentRestore`/`requestAgentRetire` call that merely
-- happens to share this row's own `kind` (a retry's own operation always carries the kind it is
-- retrying, never a kind of its own).
ALTER TABLE "agent_lifecycle_operations" ADD COLUMN "retry_of" uuid;--> statement-breakpoint
ALTER TABLE "agent_lifecycle_operations" ADD CONSTRAINT "agent_lifecycle_operations_retry_of_agent_lifecycle_operations_id_fk" FOREIGN KEY ("retry_of") REFERENCES "public"."agent_lifecycle_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The append-only guard (migration 0025) must treat `retry_of` as one more immutable identity
-- column, set at insert only, never a later writer's (`checkpointOperation`/`completeOperation`/
-- `failOperation`) to change.
CREATE OR REPLACE FUNCTION agent_lifecycle_operations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
		OR NEW.retry_of IS DISTINCT FROM OLD.retry_of
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
