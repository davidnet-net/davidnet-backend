import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth"; // Adjust path to your auth schema

// --- ENUMS ---
export const workspaceTypeEnum = authSchema.enum("workspace_type", ["personal", "organization"]);

// --- TABLES ---
export const workspaces = authSchema.table("workspaces", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	ownerId: uuid("owner_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	type: workspaceTypeEnum("type").notNull(),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- TYPE EXPORTS ---
export type workspaces = InferSelectModel<typeof workspaces>;
export type NewWorkspaces = InferInsertModel<typeof workspaces>;
