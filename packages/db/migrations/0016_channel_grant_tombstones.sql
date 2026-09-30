ALTER TABLE "mattermost_channel_grants" ALTER COLUMN "grantor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mattermost_channel_grants" ALTER COLUMN "evidence_post_id" DROP NOT NULL;