CREATE TABLE "auth"."signup_status" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verification_token" uuid DEFAULT uuidv4() NOT NULL,
	"privacy_step_completed" boolean DEFAULT false NOT NULL,
	"preferences_step_completed" boolean DEFAULT false NOT NULL,
	"signup_token" uuid DEFAULT uuidv4() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."signup_status" ADD CONSTRAINT "signup_status_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;