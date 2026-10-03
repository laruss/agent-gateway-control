CREATE TABLE "config_attachment_snapshots" (
	"hash" text PRIMARY KEY NOT NULL,
	"bundle" jsonb NOT NULL,
	"format" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_entries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_entries" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "config_revisions" ADD COLUMN "attachments_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "config_revisions" ADD CONSTRAINT "config_revisions_attachments_snapshot_hash_config_attachment_snapshots_hash_fk" FOREIGN KEY ("attachments_snapshot_hash") REFERENCES "public"."config_attachment_snapshots"("hash") ON DELETE no action ON UPDATE no action;