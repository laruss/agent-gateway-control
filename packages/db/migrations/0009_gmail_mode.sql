ALTER TABLE "gmail_mailboxes" ADD COLUMN "mode" text DEFAULT 'pubsub' NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_mailboxes" ADD COLUMN "sync_seconds" integer;--> statement-breakpoint
ALTER TABLE "gmail_mailboxes" ADD CONSTRAINT "gmail_mailboxes_mode" CHECK (mode in ('poll', 'pubsub'));