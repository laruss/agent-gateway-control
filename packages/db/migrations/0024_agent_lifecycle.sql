CREATE TABLE "agent_lifecycle" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"operation_id" uuid,
	"last_error" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "agent_lifecycle_status" CHECK (status in ('pending', 'reconciling', 'ready', 'failed', 'retiring', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "agent_lifecycle_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"requested_by" text NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text,
	"config_revision_id" bigint,
	"generation" bigint NOT NULL,
	"state" text NOT NULL,
	"checkpoints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_lifecycle_operations_kind" CHECK (kind in ('create', 'retire', 'restore', 'reprovision', 'adopt')),
	CONSTRAINT "agent_lifecycle_operations_source" CHECK (source in ('cli', 'console', 'agent')),
	CONSTRAINT "agent_lifecycle_operations_state" CHECK (state in ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent_lifecycle" ADD CONSTRAINT "agent_lifecycle_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lifecycle_operations" ADD CONSTRAINT "agent_lifecycle_operations_agent_id_agent_lifecycle_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_lifecycle"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lifecycle_operations" ADD CONSTRAINT "agent_lifecycle_operations_config_revision_id_config_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."config_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_lifecycle_operations_agent" ON "agent_lifecycle_operations" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_lifecycle_operations_idempotency_key" ON "agent_lifecycle_operations" USING btree ("idempotency_key") WHERE "agent_lifecycle_operations"."idempotency_key" is not null;