ALTER TABLE "config_revisions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "config_revisions" ADD COLUMN "change_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "config_revisions_idempotency_key" ON "config_revisions" USING btree ("idempotency_key") WHERE "config_revisions"."idempotency_key" is not null;