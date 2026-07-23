CREATE TABLE "auth"."user_security" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"authenticator_enabled" boolean DEFAULT false NOT NULL,
	"authenticator_seed" text,
	"backup_codes" jsonb,
	"last_used_totp_window" integer
);
--> statement-breakpoint
ALTER TABLE "auth"."user_security" ADD CONSTRAINT "user_security_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;