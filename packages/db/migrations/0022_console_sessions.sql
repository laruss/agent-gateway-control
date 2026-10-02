CREATE TABLE "console_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"password_hash_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "console_sessions_token_hash" ON "console_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "console_sessions_active" ON "console_sessions" USING btree ("revoked_at","expires_at");