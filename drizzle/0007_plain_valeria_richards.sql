CREATE TABLE "auth"."internal_access" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"internal_access" boolean DEFAULT false NOT NULL,
	"vpn_access" boolean DEFAULT false NOT NULL,
	"dbs_access" boolean DEFAULT false NOT NULL,
	"support_access" boolean DEFAULT false NOT NULL,
	"monitoring_access" boolean DEFAULT false NOT NULL,
	"developer_access" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."internal_access" ADD CONSTRAINT "internal_access_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;