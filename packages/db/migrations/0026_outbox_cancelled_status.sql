ALTER TABLE "outbox" DROP CONSTRAINT "outbox_status";--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_status" CHECK (status in ('pending', 'sending', 'sent', 'dead', 'cancelled'));