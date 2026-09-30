CREATE TABLE "mattermost_channel_grants" (
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"team_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"state" text NOT NULL,
	"grantor_user_id" text NOT NULL,
	"evidence_post_id" text NOT NULL,
	"since_ms" bigint NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"revoked_reason" text,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mattermost_channel_grants_agent_id_channel_id_pk" PRIMARY KEY("agent_id","channel_id"),
	CONSTRAINT "mattermost_channel_grants_state" CHECK (state in ('active', 'revoked')),
	CONSTRAINT "mattermost_channel_grants_revoked" CHECK (("mattermost_channel_grants"."state" = 'revoked') = ("mattermost_channel_grants"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "mattermost_channel_grants" ADD CONSTRAINT "mattermost_channel_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mattermost_channel_grants_channel" ON "mattermost_channel_grants" USING btree ("channel_id");