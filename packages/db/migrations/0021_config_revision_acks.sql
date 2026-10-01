CREATE TABLE "config_revision_acks" (
	"revision_id" bigint PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"acked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_revision_acks" ADD CONSTRAINT "config_revision_acks_revision_id_config_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."config_revisions"("id") ON DELETE no action ON UPDATE no action;