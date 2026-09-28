CREATE TABLE "alert_states" (
	"key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"episode" integer NOT NULL,
	"message" text NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "alert_states_state" CHECK (state in ('firing', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_status" (
	"task" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_redacted" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "traceparent" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "content_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "content_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "traceparent" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "content_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "content_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_actions" ADD COLUMN "traceparent" text;--> statement-breakpoint
CREATE INDEX "agent_inbox_event" ON "agent_inbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "agent_inbox_open_wait" ON "agent_inbox" USING btree ("wait_id") WHERE "agent_inbox"."status" in ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "agent_runs_retention" ON "agent_runs" USING btree ("finished_at") WHERE "agent_runs"."content_expired_at" is null;--> statement-breakpoint
CREATE INDEX "agent_runs_invalid_output" ON "agent_runs" USING btree ("runtime_adapter") WHERE "agent_runs"."error_code" = 'invalid_output';--> statement-breakpoint
CREATE INDEX "context_snapshots_created" ON "context_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_retention" ON "events" USING btree ("received_at") WHERE "events"."content_expired_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_retention" ON "outbox" USING btree ("status","created_at") WHERE "outbox"."content_expired_at" is null;--> statement-breakpoint
CREATE INDEX "policy_decisions_retention" ON "policy_decisions" USING btree ("created_at") WHERE "policy_decisions"."content_expired_at" is null;--> statement-breakpoint
CREATE INDEX "wait_subscriptions_created_by" ON "wait_subscriptions" USING btree ("created_by_run_id");