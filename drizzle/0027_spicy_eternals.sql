CREATE TYPE "auth"."report_status" AS ENUM('pending', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "auth"."report_type" AS ENUM('profile', 'short');--> statement-breakpoint
CREATE TABLE "auth"."account_moderation_status" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"report_trust_score" integer DEFAULT 100 NOT NULL,
	"banned_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reported_user_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"report_type" "auth"."report_type" NOT NULL,
	"reported_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "auth"."report_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."violations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"reported_type" "auth"."report_type" NOT NULL,
	"reported_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"moderator_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."account_moderation_status" ADD CONSTRAINT "account_moderation_status_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."reports" ADD CONSTRAINT "reports_reported_user_id_users_user_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."reports" ADD CONSTRAINT "reports_reporter_id_users_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."violations" ADD CONSTRAINT "violations_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;