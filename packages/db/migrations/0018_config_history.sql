CREATE TABLE "config_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_hash" text NOT NULL,
	"parent_revision_id" bigint,
	"generation" bigint NOT NULL,
	"actor" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_revisions_source" CHECK (source in ('cli_apply', 'backfill', 'console', 'agent', 'rollback', 'import'))
);
--> statement-breakpoint
CREATE TABLE "config_snapshots" (
	"hash" text PRIMARY KEY NOT NULL,
	"bundle" jsonb NOT NULL,
	"format" integer NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_snapshots_origin" CHECK (origin in ('applied', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "gateway_controls" ADD COLUMN "active_config_revision" bigint;--> statement-breakpoint
ALTER TABLE "config_revisions" ADD CONSTRAINT "config_revisions_snapshot_hash_config_snapshots_hash_fk" FOREIGN KEY ("snapshot_hash") REFERENCES "public"."config_snapshots"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_revisions" ADD CONSTRAINT "config_revisions_parent_revision_id_config_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."config_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_revisions_snapshot" ON "config_revisions" USING btree ("snapshot_hash");