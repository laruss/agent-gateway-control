CREATE TABLE "thread_summaries" (
	"channel_id" text NOT NULL,
	"root_post_id" text NOT NULL,
	"summary" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_summaries_channel_id_root_post_id_pk" PRIMARY KEY("channel_id","root_post_id")
);
--> statement-breakpoint
ALTER TABLE "wait_subscriptions" ADD COLUMN "thread_root_ids" jsonb;--> statement-breakpoint
CREATE INDEX "events_causation" ON "events" USING btree ("causation_id") WHERE "events"."causation_id" is not null;--> statement-breakpoint
CREATE INDEX "events_thread" ON "events" USING btree (("payload"->>'channel_id'),coalesce("payload"->>'root_id', "payload"->>'post_id')) WHERE "events"."payload" ? 'post_id';--> statement-breakpoint
CREATE INDEX "memory_items_status" ON "memory_items" USING btree ("status","namespace","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_items_accepted_key" ON "memory_items" USING btree ("namespace","key") WHERE "memory_items"."status" = 'accepted';