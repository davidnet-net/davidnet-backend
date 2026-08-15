CREATE TYPE "auth"."workspace_type" AS ENUM('personal', 'organization');--> statement-breakpoint
CREATE TABLE "auth"."workspaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" "auth"."workspace_type" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."workspaces" ADD CONSTRAINT "workspaces_owner_id_users_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;