CREATE TYPE "auth"."community_game_audit_action" AS ENUM('view_save', 'edit_save', 'delete_save', 'edit_highscore', 'delete_highscore');--> statement-breakpoint
CREATE TABLE "auth"."community_game_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"game_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"target_user_id" uuid,
	"action" "auth"."community_game_audit_action" NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."community_game_highscores" (
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_game_highscores_game_id_user_id_pk" PRIMARY KEY("game_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."community_game_saves" (
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_game_saves_game_id_user_id_pk" PRIMARY KEY("game_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "auth"."community_games" ADD COLUMN "is_ai_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."community_game_audit_log" ADD CONSTRAINT "community_game_audit_log_game_id_community_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "auth"."community_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_audit_log" ADD CONSTRAINT "community_game_audit_log_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_audit_log" ADD CONSTRAINT "community_game_audit_log_target_user_id_users_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_highscores" ADD CONSTRAINT "community_game_highscores_game_id_community_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "auth"."community_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_highscores" ADD CONSTRAINT "community_game_highscores_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_saves" ADD CONSTRAINT "community_game_saves_game_id_community_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "auth"."community_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."community_game_saves" ADD CONSTRAINT "community_game_saves_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;