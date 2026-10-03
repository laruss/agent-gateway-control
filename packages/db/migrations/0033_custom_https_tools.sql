ALTER TABLE "catalog_entries" DROP CONSTRAINT "catalog_entries_kind";--> statement-breakpoint
ALTER TABLE "catalog_entry_versions" DROP CONSTRAINT "catalog_entry_versions_kind";--> statement-breakpoint
ALTER TABLE "tool_actions" DROP CONSTRAINT "tool_actions_namespace";--> statement-breakpoint
ALTER TABLE "catalog_entry_versions" ADD COLUMN "https_definition" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_entries" ADD CONSTRAINT "catalog_entries_kind" CHECK (kind in ('native', 'gateway', 'executor', 'custom_https', 'utility'));--> statement-breakpoint
ALTER TABLE "catalog_entry_versions" ADD CONSTRAINT "catalog_entry_versions_kind" CHECK (kind in ('native', 'gateway', 'executor', 'custom_https', 'utility'));--> statement-breakpoint
ALTER TABLE "tool_actions" ADD CONSTRAINT "tool_actions_namespace" CHECK (namespace in ('finance', 'mail', 'deploy', 'publish', 'issue', 'custom', 'utility'));