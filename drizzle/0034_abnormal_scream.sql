CREATE TABLE "auth"."community_game_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"last_signed_timestamp" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."community_game_sessions" ADD CONSTRAINT "community_game_sessions_game_id_community_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "auth"."community_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_sessions" ADD CONSTRAINT "community_game_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;