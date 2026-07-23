ALTER TABLE "auth"."session_tokens" ADD COLUMN "ip" text NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."session_tokens" ADD COLUMN "user_agent" text NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."session_tokens" ADD COLUMN "country_code" text NOT NULL;