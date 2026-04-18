ALTER TABLE "auth"."user_tokens" ALTER COLUMN "jwt_id" SET DEFAULT make_uuidv7();--> statement-breakpoint
ALTER TABLE "auth"."users" ALTER COLUMN "user_id" SET DEFAULT make_uuidv7();--> statement-breakpoint
ALTER TABLE "auth"."users" ADD COLUMN "password" text NOT NULL;