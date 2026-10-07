CREATE TABLE "auth"."community_game_levels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."community_game_achievements" ADD COLUMN "progress" integer;--> statement-breakpoint
ALTER TABLE "auth"."community_game_achievements" ADD COLUMN "target" integer;--> statement-breakpoint
ALTER TABLE "auth"."community_game_achievements" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "auth"."community_game_achievements" SET "completed_at" = "unlocked_at" WHERE "completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "auth"."community_game_saves" ADD COLUMN "slot" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."community_game_saves" DROP CONSTRAINT "community_game_saves_game_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "auth"."community_game_saves" ADD CONSTRAINT "community_game_saves_game_id_user_id_slot_pk" PRIMARY KEY("game_id","user_id","slot");--> statement-breakpoint
ALTER TABLE "auth"."community_game_levels" ADD CONSTRAINT "community_game_levels_game_id_community_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "auth"."community_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_levels" ADD CONSTRAINT "community_game_levels_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;