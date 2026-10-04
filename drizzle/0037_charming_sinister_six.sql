CREATE TYPE "auth"."media_type" AS ENUM('image', 'youtube');--> statement-breakpoint
CREATE TYPE "auth"."reveal_mode" AS ENUM('instant', 'fade', 'blur', 'slide');--> statement-breakpoint
ALTER TABLE "auth"."questions" ADD COLUMN "media_type" "auth"."media_type";--> statement-breakpoint
ALTER TABLE "auth"."questions" ADD COLUMN "reveal_mode" "auth"."reveal_mode" DEFAULT 'instant' NOT NULL;