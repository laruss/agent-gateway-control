CREATE TABLE "approval_replies" (
	"post_id" text PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"notice" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_usage" (
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"agent_id" text NOT NULL,
	"day" text NOT NULL,
	"cost_usd" numeric(14, 6),
	"tokens" bigint,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_usage_run_id_attempt_pk" PRIMARY KEY("run_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "tool_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"namespace" text NOT NULL,
	"action_type" text NOT NULL,
	"action_params" jsonb NOT NULL,
	"immutable_action_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"config_version" text NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"receipt" jsonb,
	"error_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_actions_approval_id_unique" UNIQUE("approval_id"),
	CONSTRAINT "tool_actions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "tool_actions_status" CHECK (status in ('queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled')),
	CONSTRAINT "tool_actions_namespace" CHECK (namespace in ('finance', 'mail', 'deploy', 'publish', 'issue'))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_status";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_kind";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "decision_post_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_replies" ADD CONSTRAINT "approval_replies_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_actions" ADD CONSTRAINT "tool_actions_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_actions" ADD CONSTRAINT "tool_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_usage_day" ON "run_usage" USING btree ("day","agent_id");--> statement-breakpoint
CREATE INDEX "tool_actions_open" ON "tool_actions" USING btree ("status","deadline_at");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_status" CHECK (status in ('pending', 'granted', 'denied', 'expired', 'cancelled'));--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_kind" CHECK (kind in ('mattermost.post', 'mattermost.alert', 'mattermost.approval', 'mattermost.approval.reply'));