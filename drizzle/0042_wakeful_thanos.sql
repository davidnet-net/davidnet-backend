CREATE TABLE "auth"."community_game_playtime" (
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"total_playtime_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_game_playtime_game_id_user_id_pk" PRIMARY KEY("game_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "auth"."user_privacy_preferences" ADD COLUMN "achievements_visibility" "auth"."visibility_type" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."user_privacy_preferences" ADD COLUMN "leaderboard_visibility" "auth"."visibility_type" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."community_game_playtime" ADD CONSTRAINT "community_game_playtime_game_id_community_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "auth"."community_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_playtime" ADD CONSTRAINT "community_game_playtime_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;