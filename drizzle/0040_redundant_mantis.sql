CREATE TYPE "auth"."ban_event_action" AS ENUM('ban', 'unban');--> statement-breakpoint
CREATE TABLE "auth"."ban_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"moderator_id" uuid NOT NULL,
	"action" "auth"."ban_event_action" NOT NULL,
	"banned_until" timestamp with time zone,
	"violation_id" uuid,
	"reason" text,
	"moderator_ip" text,
	"moderator_country_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."banned_ips" (
	"ip" text PRIMARY KEY NOT NULL,
	"moderator_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."user_ip_log" (
	"user_id" uuid NOT NULL,
	"ip" text NOT NULL,
	"country_code" text,
	"user_agent" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ip_log_user_id_ip_pk" PRIMARY KEY("user_id","ip")
);
--> statement-breakpoint
ALTER TABLE "auth"."violations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."ban_events" ADD CONSTRAINT "ban_events_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."ban_events" ADD CONSTRAINT "ban_events_moderator_id_users_user_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."ban_events" ADD CONSTRAINT "ban_events_violation_id_violations_id_fk" FOREIGN KEY ("violation_id") REFERENCES "auth"."violations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."banned_ips" ADD CONSTRAINT "banned_ips_moderator_id_users_user_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_ip_log" ADD CONSTRAINT "user_ip_log_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;