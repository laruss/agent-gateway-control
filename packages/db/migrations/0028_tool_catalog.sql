CREATE TABLE "catalog_attachments" (
	"agent_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"pinned_version" integer,
	"mode" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_attachments_agent_id_entry_id_pk" PRIMARY KEY("agent_id","entry_id"),
	CONSTRAINT "catalog_attachments_mode" CHECK (mode in ('allow', 'require_approval', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "catalog_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"implementation_key" text NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"current_version_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_entries_kind" CHECK (kind in ('native', 'gateway', 'executor', 'custom_https'))
);
--> statement-breakpoint
CREATE TABLE "catalog_entry_tombstones" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"deleted_by" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_entry_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"implementation_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"config_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_floor" text NOT NULL,
	"supported_adapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_entry_versions_kind" CHECK (kind in ('native', 'gateway', 'executor', 'custom_https')),
	CONSTRAINT "catalog_entry_versions_risk_floor" CHECK (risk_floor in ('allow', 'require_approval'))
);
--> statement-breakpoint
ALTER TABLE "catalog_attachments" ADD CONSTRAINT "catalog_attachments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_attachments" ADD CONSTRAINT "catalog_attachments_entry_id_catalog_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."catalog_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_attachments_entry" ON "catalog_attachments" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_entry_versions_entry_version" ON "catalog_entry_versions" USING btree ("entry_id","version");--> statement-breakpoint
CREATE INDEX "catalog_entry_versions_entry" ON "catalog_entry_versions" USING btree ("entry_id");