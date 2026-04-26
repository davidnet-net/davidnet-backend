import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { jsonb, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

export const analyticsSchema = pgSchema("analytics");

// --- ENUMS ---

// --- TABLES ---
export const legalAccept = analyticsSchema.table("legal_accept", {
	legalAcceptID: uuid("legal_accept_id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	data: jsonb("data").notNull() // Eg versions of each policy
});

export type legalAccept = InferSelectModel<typeof legalAccept>;
export type newlegalAccept = InferInsertModel<typeof legalAccept>;
