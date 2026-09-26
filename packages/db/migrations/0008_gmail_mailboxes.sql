CREATE TABLE "gmail_mailboxes" (
	"mailbox_id" text PRIMARY KEY NOT NULL,
	"account_hash" text NOT NULL,
	"history_id" numeric(20, 0) NOT NULL,
	"watch_expires_at" timestamp with time zone,
	"watch_renewed_at" timestamp with time zone,
	"last_notification_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
