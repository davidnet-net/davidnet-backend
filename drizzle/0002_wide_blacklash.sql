CREATE TABLE "auth"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."user_tokens" RENAME TO "session_tokens";--> statement-breakpoint
ALTER TABLE "auth"."session_tokens" DROP CONSTRAINT "user_tokens_user_id_users_user_id_fk";
--> statement-breakpoint
ALTER TABLE "auth"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session_tokens" ADD CONSTRAINT "session_tokens_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."signup_status" DROP COLUMN "privacy_step_completed";