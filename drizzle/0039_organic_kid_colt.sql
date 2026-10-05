CREATE TABLE "auth"."community_game_achievements" (
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_game_achievements_game_id_user_id_achievement_id_pk" PRIMARY KEY("game_id","user_id","achievement_id")
);
--> statement-breakpoint
ALTER TABLE "auth"."community_game_highscores" DROP CONSTRAINT "community_game_highscores_game_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "auth"."community_game_highscores" ADD CONSTRAINT "community_game_highscores_game_id_user_id_category_pk" PRIMARY KEY("game_id","user_id","category");--> statement-breakpoint
ALTER TABLE "auth"."community_game_highscores" ADD COLUMN "category" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."community_game_achievements" ADD CONSTRAINT "community_game_achievements_game_id_community_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "auth"."community_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_achievements" ADD CONSTRAINT "community_game_achievements_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;