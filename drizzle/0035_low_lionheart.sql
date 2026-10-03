ALTER TYPE "auth"."community_game_audit_action" ADD VALUE 'approve_highscore';--> statement-breakpoint
ALTER TABLE "auth"."community_game_highscores" ADD COLUMN "flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."community_game_highscores" ADD COLUMN "flag_reason" text;