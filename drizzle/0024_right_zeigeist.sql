CREATE TYPE "auth"."request_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "auth"."collaboration_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" "auth"."request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth"."collaboration_requests" ADD CONSTRAINT "collaboration_requests_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "auth"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."collaboration_requests" ADD CONSTRAINT "collaboration_requests_inviter_id_users_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."quiz_collaborators" DROP COLUMN "role";