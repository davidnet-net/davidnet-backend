import { pgSchema, uuid, jsonb } from "drizzle-orm/pg-core";
import { type InferSelectModel, type InferInsertModel } from "drizzle-orm";

export const analyticsSchema = pgSchema("analytics");

// --- ENUMS ---


// --- TABLES ---
export const feedback = analyticsSchema.table("feedback", {
    feedbackId: uuid("feedback_id").primaryKey(), // Expects UUIDv7
    userId: uuid("user_id")
        .notNull(),
    data: jsonb("data").notNull(),
});

export type feedback = InferSelectModel<typeof feedback>;
export type newFeedback = InferInsertModel<typeof feedback>;