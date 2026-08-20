CREATE TABLE "auth"."custom_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth"."role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "auth"."team_user_roles" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "team_user_roles_team_id_user_id_role_id_pk" PRIMARY KEY("team_id","user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."teams" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."workspace_user_roles" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "workspace_user_roles_workspace_id_user_id_role_id_pk" PRIMARY KEY("workspace_id","user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "auth"."custom_roles" ADD CONSTRAINT "custom_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "auth"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_custom_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "auth"."custom_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "auth"."permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."team_user_roles" ADD CONSTRAINT "team_user_roles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "auth"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."team_user_roles" ADD CONSTRAINT "team_user_roles_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."team_user_roles" ADD CONSTRAINT "team_user_roles_role_id_custom_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "auth"."custom_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."teams" ADD CONSTRAINT "teams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "auth"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."workspace_user_roles" ADD CONSTRAINT "workspace_user_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "auth"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."workspace_user_roles" ADD CONSTRAINT "workspace_user_roles_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."workspace_user_roles" ADD CONSTRAINT "workspace_user_roles_role_id_custom_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "auth"."custom_roles"("id") ON DELETE cascade ON UPDATE no action;