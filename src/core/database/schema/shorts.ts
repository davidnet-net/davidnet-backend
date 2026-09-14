import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth";

// --- TABLES ---
export const shorts = authSchema.table("shorts", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),

	title: text("title").notNull(),

	// This will store the S3 key, R2 path, or local URL to the video file
	videoUrl: text("video_url").notNull(),

	// Metrics (Defaulting to 0 based on your current testing phase)
	views: integer("views").default(0).notNull(),
	likesCount: integer("likes_count").default(0).notNull(),
	watchDuration: integer("watch_duration").default(0).notNull(),
	videoLength: integer("video_length").default(0).notNull(),

	// Timestamps
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

// --- TYPE EXPORTS ---
export type Short = InferSelectModel<typeof shorts>;
export type NewShort = InferInsertModel<typeof shorts>;
