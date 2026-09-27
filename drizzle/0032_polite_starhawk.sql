CREATE TABLE "auth"."short_likes" (
	"user_id" uuid NOT NULL,
	"short_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_likes_user_id_short_id_pk" PRIMARY KEY("user_id","short_id")
);
--> statement-breakpoint
ALTER TABLE "auth"."short_likes" ADD CONSTRAINT "short_likes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."short_likes" ADD CONSTRAINT "short_likes_short_id_shorts_id_fk" FOREIGN KEY ("short_id") REFERENCES "auth"."shorts"("id") ON DELETE cascade ON UPDATE no action;