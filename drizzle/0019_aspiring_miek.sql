CREATE TYPE "auth"."question_type" AS ENUM('quiz', 'true_false', 'slider', 'puzzle', 'type_answer', 'poll', 'word_cloud', 'scale', 'information');--> statement-breakpoint
CREATE TYPE "auth"."session_status" AS ENUM('lobby', 'question_active', 'showing_leaderboard', 'finished');--> statement-breakpoint
CREATE TABLE "auth"."questions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"text" text NOT NULL,
	"media_url" text,
	"type" "auth"."question_type" DEFAULT 'quiz' NOT NULL,
	"position" integer NOT NULL,
	"time_limit" integer DEFAULT 20 NOT NULL,
	"points_multiplier" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."quiz_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"question_id" uuid NOT NULL,
	"text" text NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."quiz_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"pin_code" text NOT NULL,
	"status" "auth"."session_status" DEFAULT 'lobby' NOT NULL,
	"locked" boolean DEFAULT false,
	"current_question_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_sessions_pin_code_unique" UNIQUE("pin_code")
);
--> statement-breakpoint
CREATE TABLE "auth"."quizzes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."session_participants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"nickname" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."session_responses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"selected_option_id" uuid,
	"text_response" text,
	"answer_time_ms" integer NOT NULL,
	"points_earned" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."questions" ADD CONSTRAINT "questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "auth"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."quiz_options" ADD CONSTRAINT "quiz_options_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "auth"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."quiz_sessions" ADD CONSTRAINT "quiz_sessions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "auth"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."quizzes" ADD CONSTRAINT "quizzes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "auth"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session_participants" ADD CONSTRAINT "session_participants_session_id_quiz_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "auth"."quiz_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session_responses" ADD CONSTRAINT "session_responses_session_id_quiz_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "auth"."quiz_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session_responses" ADD CONSTRAINT "session_responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "auth"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session_responses" ADD CONSTRAINT "session_responses_participant_id_session_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "auth"."session_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session_responses" ADD CONSTRAINT "session_responses_selected_option_id_quiz_options_id_fk" FOREIGN KEY ("selected_option_id") REFERENCES "auth"."quiz_options"("id") ON DELETE set null ON UPDATE no action;