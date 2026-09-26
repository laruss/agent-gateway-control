CREATE TABLE "runtime_availability" (
	"adapter" text PRIMARY KEY NOT NULL,
	"available" boolean NOT NULL,
	"runtime_versions" jsonb NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_since" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runtime_workers" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"adapter" text NOT NULL,
	"status" text NOT NULL,
	"sequence" bigint NOT NULL,
	"runtime_version" text NOT NULL,
	"detail" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_workers_status" CHECK (status in ('ready', 'unavailable', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX "runtime_workers_adapter" ON "runtime_workers" USING btree ("adapter","last_seen_at");