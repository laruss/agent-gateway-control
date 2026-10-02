ALTER TABLE "agents" ADD COLUMN "tool_attachments_managed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill from the active revision's own attachments document (ADR-027), the authoritative
-- source: an agent's key is present there (even with an empty array) whenever it has been
-- attached to, detached from, or had an attachment edited for, at least once through the hub,
-- which `catalog_attachments` alone cannot tell apart from "never touched" once its list is
-- emptied back out.
UPDATE "agents" a
SET "tool_attachments_managed" = true
FROM "gateway_controls" gc
JOIN "config_revisions" cr ON cr.id = gc.active_config_revision
JOIN "config_attachment_snapshots" cas ON cas.hash = cr.attachments_snapshot_hash
WHERE gc.id = 1
  AND a.id IN (SELECT jsonb_object_keys(cas.bundle));