CREATE TYPE "auth"."connection_status_type" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "auth"."user_blocks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."user_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"sender_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"status" "auth"."connection_status_type" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."user_blocks" ADD CONSTRAINT "user_blocks_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_user_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_connections" ADD CONSTRAINT "user_connections_sender_id_users_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_connections" ADD CONSTRAINT "user_connections_receiver_id_users_user_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;