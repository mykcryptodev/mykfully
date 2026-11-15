ALTER TABLE "api_tokens" ADD COLUMN "can_schedule" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "can_publish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "can_delete" boolean DEFAULT false NOT NULL;