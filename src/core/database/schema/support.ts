import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { jsonb, pgSchema, uuid } from "drizzle-orm/pg-core";

export const support = pgSchema("analytics");

// --- ENUMS ---

// --- TABLES ---
export const feedbackTable = support.table("feedback", {
	feedbackId: uuid("feedback_id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id").notNull(),
	data: jsonb("data").notNull()
});

export type feedback = InferSelectModel<typeof feedbackTable>;
export type newFeedback = InferInsertModel<typeof feedbackTable>;
