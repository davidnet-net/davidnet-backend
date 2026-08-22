CREATE TABLE "auth"."quiz_collaborators" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."quiz_collaborators" ADD CONSTRAINT "quiz_collaborators_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "auth"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."quiz_collaborators" ADD CONSTRAINT "quiz_collaborators_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;