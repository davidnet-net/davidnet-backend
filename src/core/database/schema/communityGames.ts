import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { boolean, integer, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth";

// --- TABLES ---
export const communityGame = authSchema.table("community_games", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),

	title: text("title").notNull(),
	description: text("description"),

	// Metrics
	likesCount: integer("likes_count").default(0).notNull(),
	isModerated: boolean("is_moderated").default(false).notNull(),

	// Timestamps
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

// Likes tabel om dubbel liken te voorkomen
export const communityGameLikes = authSchema.table(
	"community_game_likes",
	{
		userId: uuid("user_id")
			.notNull()
			.references(() => users.userId, { onDelete: "cascade" }),
		gameId: uuid("game_id")
			.notNull()
			.references(() => communityGame.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [primaryKey({ columns: [table.userId, table.gameId] })]
);

// --- TYPE EXPORTS ---
export type CommunityGame = InferSelectModel<typeof communityGame>;
export type NewCommunityGame = InferInsertModel<typeof communityGame>;

export type CommunityGameLike = InferSelectModel<typeof communityGameLikes>;
export type NewCommunityGameLike = InferInsertModel<typeof communityGameLikes>;
