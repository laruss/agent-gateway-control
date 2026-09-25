CREATE TABLE "agent_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid,
	"wait_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_inbox_status" CHECK (status in ('pending', 'claimed', 'consumed', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"trigger_event_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer NOT NULL,
	"runtime_adapter" text NOT NULL,
	"runtime_version" text,
	"model" text,
	"correlation_id" text NOT NULL,
	"hop" integer NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"timeout_at" timestamp with time zone NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"outcome" text,
	"error_code" text,
	"error_detail_redacted" text,
	"usage" jsonb,
	"public_summary" jsonb,
	"result" jsonb,
	"parent_run_id" uuid,
	"job_id" text,
	CONSTRAINT "agent_runs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "agent_runs_status" CHECK (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "agent_runs_outcome" CHECK ("agent_runs"."outcome" is null or outcome in ('idle', 'waiting', 'needs_human', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"state" text NOT NULL,
	"runtime_adapter" text NOT NULL,
	"runtime_profile" text NOT NULL,
	"config_version" text NOT NULL,
	"max_active_runs" integer NOT NULL,
	"config" jsonb NOT NULL,
	"role_prompt" text NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_state" CHECK (state in ('disabled', 'idle', 'queued', 'running', 'waiting', 'failed', 'paused')),
	CONSTRAINT "agents_enabled_state" CHECK ("agents"."enabled" = ("agents"."state" <> 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_agent_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"action_params" jsonb NOT NULL,
	"immutable_action_hash" text NOT NULL,
	"action_summary" text NOT NULL,
	"risk_level" text NOT NULL,
	"status" text NOT NULL,
	"allowed_approver_user_ids" jsonb NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approval_requests_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "approval_requests_status" CHECK (status in ('pending', 'granted', 'denied', 'expired', 'executed')),
	CONSTRAINT "approval_requests_risk" CHECK (risk_level in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "approval_requests_expiry" CHECK ("approval_requests"."expires_at" > "approval_requests"."created_at")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"workspace_path" text,
	"url" text,
	"sha256" text,
	"mime_type" text,
	"size_bytes" integer,
	"visibility" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_visibility" CHECK (visibility in ('private', 'shared', 'public')),
	CONSTRAINT "artifacts_location" CHECK (("artifacts"."workspace_path" is null) <> ("artifacts"."url" is null))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"organization" jsonb NOT NULL,
	"constitution" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"config_version" text NOT NULL,
	"thread_ref" text,
	"input" jsonb NOT NULL,
	"authority" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_snapshots_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "event_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"wait_id" uuid,
	"cascade_anchor" bigint,
	"policy_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_routes_decision" CHECK (decision in ('wake', 'ignore', 'wait-match', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"specversion" text NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"subject" text,
	"time" timestamp with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"traceparent" text,
	"trust_level" text NOT NULL,
	"hop" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"content_hash" text,
	"sender_agent_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "gateway_controls" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"active_config_version" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_controls_single_row" CHECK ("gateway_controls"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "mattermost_directory" (
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mattermost_id" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mattermost_directory_kind_name_pk" PRIMARY KEY("kind","name"),
	CONSTRAINT "mattermost_directory_kind" CHECK (kind in ('channel', 'user'))
);
--> statement-breakpoint
CREATE TABLE "mattermost_identities" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"mattermost_user_id" text,
	"username" text NOT NULL,
	"token_secret_ref" text NOT NULL,
	"last_verified_at" timestamp with time zone,
	CONSTRAINT "mattermost_identities_mattermost_user_id_unique" UNIQUE("mattermost_user_id"),
	CONSTRAINT "mattermost_identities_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"source_event_id" uuid,
	"source_run_id" uuid,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "memory_items_status" CHECK (status in ('proposed', 'accepted', 'rejected', 'superseded')),
	CONSTRAINT "memory_items_visibility" CHECK (visibility in ('private', 'shared', 'public'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"destination" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error_redacted" text,
	"receipt" jsonb,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "outbox_status" CHECK (status in ('pending', 'sending', 'sent', 'dead')),
	CONSTRAINT "outbox_kind" CHECK (kind in ('mattermost.post', 'mattermost.alert', 'mattermost.approval'))
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"agent_id" text NOT NULL,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"policy_version" text NOT NULL,
	"input_redacted" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_decisions_decision" CHECK (decision in ('allow', 'deny', 'require_approval'))
);
--> statement-breakpoint
CREATE TABLE "runtime_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"adapter" text NOT NULL,
	"provider_session_ref" text NOT NULL,
	"runtime_version" text NOT NULL,
	"resume_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text NOT NULL,
	CONSTRAINT "runtime_sessions_status" CHECK (status in ('active', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "source_cursors" (
	"source_id" text PRIMARY KEY NOT NULL,
	"cursor_type" text NOT NULL,
	"cursor_value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wait_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"created_by_run_id" uuid NOT NULL,
	"status" text NOT NULL,
	"event_type" text NOT NULL,
	"correlation_id" text NOT NULL,
	"condition" jsonb NOT NULL,
	"timeout_at" timestamp with time zone NOT NULL,
	"matched_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "wait_subscriptions_status" CHECK (status in ('active', 'matched', 'timed_out', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_event_id_events_id_fk" FOREIGN KEY ("trigger_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_config_version_config_versions_version_fk" FOREIGN KEY ("config_version") REFERENCES "public"."config_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_routes" ADD CONSTRAINT "event_routes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_routes" ADD CONSTRAINT "event_routes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mattermost_identities" ADD CONSTRAINT "mattermost_identities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_source_run_id_agent_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_sessions" ADD CONSTRAINT "runtime_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_subscriptions" ADD CONSTRAINT "wait_subscriptions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_subscriptions" ADD CONSTRAINT "wait_subscriptions_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wait_subscriptions" ADD CONSTRAINT "wait_subscriptions_matched_event_id_events_id_fk" FOREIGN KEY ("matched_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_unique" ON "agent_inbox" USING btree ("agent_id","event_id");--> statement-breakpoint
CREATE INDEX "agent_inbox_pending" ON "agent_inbox" USING btree ("agent_id","status","priority","available_at");--> statement-breakpoint
CREATE INDEX "agent_runs_agent" ON "agent_runs" USING btree ("agent_id","queued_at");--> statement-breakpoint
CREATE INDEX "agent_runs_correlation" ON "agent_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_active" ON "agent_runs" USING btree ("agent_id") WHERE "agent_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_run_key" ON "artifacts" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "audit_log_subject" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_routes_unique" ON "event_routes" USING btree ("event_id","agent_id","decision");--> statement-breakpoint
CREATE INDEX "event_routes_agent" ON "event_routes" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_external_id" ON "events" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "events_correlation" ON "events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "events_content_hash" ON "events" USING btree ("content_hash","received_at");--> statement-breakpoint
CREATE INDEX "events_sender_agent" ON "events" USING btree ("sender_agent_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mattermost_directory_id" ON "mattermost_directory" USING btree ("kind","mattermost_id");--> statement-breakpoint
CREATE INDEX "memory_items_namespace" ON "memory_items" USING btree ("namespace","key");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "policy_decisions_run" ON "policy_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_sessions_agent_adapter" ON "runtime_sessions" USING btree ("agent_id","adapter");--> statement-breakpoint
CREATE INDEX "wait_subscriptions_active" ON "wait_subscriptions" USING btree ("status","correlation_id");--> statement-breakpoint
CREATE INDEX "wait_subscriptions_agent" ON "wait_subscriptions" USING btree ("agent_id","status");