import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth"; // Adjust path to your auth schema

// --- ENUMS ---
export const connectionStatusEnum = authSchema.enum("connection_status_type", [
	"pending",
	"accepted",
	"rejected"
]);

// --- TABLES ---

export const userConnections = authSchema.table("user_connections", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	senderId: uuid("sender_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	receiverId: uuid("receiver_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	status: connectionStatusEnum("status").default("pending").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const userBlocks = authSchema.table("user_blocks", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	blockedId: uuid("blocked_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- TYPE EXPORTS ---
export type UserConnection = InferSelectModel<typeof userConnections>;
export type NewUserConnection = InferInsertModel<typeof userConnections>;

export type UserBlock = InferSelectModel<typeof userBlocks>;
export type NewUserBlock = InferInsertModel<typeof userBlocks>;
