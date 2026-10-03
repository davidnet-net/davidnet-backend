import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { authSchema, users } from "./auth";

// --- ENUMS ---
export const communityGameAuditActionEnum = authSchema.enum("community_game_audit_action", [
	"view_save",
	"edit_save",
	"delete_save",
	"edit_highscore",
	"delete_highscore",
	"approve_highscore"
]);

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

	// Disclosure: was this game built entirely by AI (not just AI-assisted)?
	isAiGenerated: boolean("is_ai_generated").default(false).notNull(),

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

// Per-player highscore for a community game. Global leaderboard = order by score desc.
export const communityGameHighscores = authSchema.table(
	"community_game_highscores",
	{
		gameId: uuid("game_id")
			.notNull()
			.references(() => communityGame.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.userId, { onDelete: "cascade" }),
		score: integer("score").notNull(),
		// Set when a score is a statistical outlier vs. the rest of the leaderboard (see the
		// anomaly check in the highscore route). Flagged scores are excluded from the public
		// leaderboard/global-best until a creator or moderator clears the flag.
		flagged: boolean("flagged").default(false).notNull(),
		flagReason: text("flag_reason"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [primaryKey({ columns: [table.gameId, table.userId] })]
);

// Arbitrary JSON save-data blob per player per community game.
export const communityGameSaves = authSchema.table(
	"community_game_saves",
	{
		gameId: uuid("game_id")
			.notNull()
			.references(() => communityGame.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.userId, { onDelete: "cascade" }),
		data: jsonb("data").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [primaryKey({ columns: [table.gameId, table.userId] })]
);

// Per-session anti-cheat secret for a community game play session. Issued once when the game's
// iframe loads; kept only in that iframe's JS closure (never exposed on window.DavidnetSDK). Score
// submissions are HMAC-signed with this secret so they can't be forged by scripting postMessage
// calls from outside the iframe (e.g. the parent page's own devtools console).
export const communityGameSessions = authSchema.table("community_game_sessions", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	gameId: uuid("game_id")
		.notNull()
		.references(() => communityGame.id, { onDelete: "cascade" }),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	secret: text("secret").notNull(),
	// Timestamp (ms) of the last accepted signed request, to reject replayed signatures.
	lastSignedTimestamp: bigint("last_signed_timestamp", { mode: "number" }).default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
});

// Audit trail of creator/moderator actions performed on a player's save or highscore data.
export const communityGameAuditLog = authSchema.table("community_game_audit_log", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	gameId: uuid("game_id")
		.notNull()
		.references(() => communityGame.id, { onDelete: "cascade" }),
	creatorId: uuid("creator_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	// Null = bulk action affecting the whole player list (e.g. viewing the manage overview).
	targetUserId: uuid("target_user_id").references(() => users.userId, { onDelete: "cascade" }),
	action: communityGameAuditActionEnum("action").notNull(),
	details: jsonb("details"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- TYPE EXPORTS ---
export type CommunityGame = InferSelectModel<typeof communityGame>;
export type NewCommunityGame = InferInsertModel<typeof communityGame>;

export type CommunityGameLike = InferSelectModel<typeof communityGameLikes>;
export type NewCommunityGameLike = InferInsertModel<typeof communityGameLikes>;

export type CommunityGameHighscore = InferSelectModel<typeof communityGameHighscores>;
export type NewCommunityGameHighscore = InferInsertModel<typeof communityGameHighscores>;

export type CommunityGameSave = InferSelectModel<typeof communityGameSaves>;
export type NewCommunityGameSave = InferInsertModel<typeof communityGameSaves>;

export type CommunityGameAuditLog = InferSelectModel<typeof communityGameAuditLog>;
export type NewCommunityGameAuditLog = InferInsertModel<typeof communityGameAuditLog>;

export type CommunityGameSession = InferSelectModel<typeof communityGameSessions>;
export type NewCommunityGameSession = InferInsertModel<typeof communityGameSessions>;
