CREATE SCHEMA "analytics";
--> statement-breakpoint
CREATE TABLE "analytics"."feedback" (
	"feedback_id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"data" jsonb NOT NULL
);
