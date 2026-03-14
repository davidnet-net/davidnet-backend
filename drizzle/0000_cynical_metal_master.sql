CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TYPE "auth"."theme_type" AS ENUM('dark', 'light', 'contrast', 'system');--> statement-breakpoint
CREATE TYPE "auth"."visibility_type" AS ENUM('private', 'organizations', 'connections', 'organizations_and_connections', 'public');--> statement-breakpoint
CREATE TABLE "auth"."user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" "auth"."theme_type" DEFAULT 'system' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"first_day_of_week" text DEFAULT 'monday' NOT NULL,
	"date_format" text DEFAULT 'YYYY-MM-DD' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."user_privacy_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"language_visibility" "auth"."visibility_type" DEFAULT 'private' NOT NULL,
	"timezone_visibility" "auth"."visibility_type" DEFAULT 'private' NOT NULL,
	"location_visibility" "auth"."visibility_type" DEFAULT 'private' NOT NULL,
	"email_visibility" "auth"."visibility_type" DEFAULT 'private' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."user_tokens" (
	"jwt_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"banner_url" text,
	"description" text,
	"email" text NOT NULL,
	"country_code" text,
	"location" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "auth"."user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_privacy_preferences" ADD CONSTRAINT "user_privacy_preferences_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;