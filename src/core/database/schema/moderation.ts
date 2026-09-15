import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth";

// --- ENUMS ---
export const reportTypeEnum = authSchema.enum("report_type", ["profile", "short"]);
export const reportStatusEnum = authSchema.enum("report_status", [
	"pending",
	"resolved",
	"dismissed"
]);

// --- TABLES ---
export const reports = authSchema.table("reports", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	reportedUserId: uuid("reported_user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	reporterId: uuid("reporter_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	reportType: reportTypeEnum("report_type").notNull(),
	reportedId: uuid("reported_id").notNull(),
	reason: text("reason").notNull(),
	status: reportStatusEnum("status").default("pending").notNull(),
	// Timestamps
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const accountModerationStatus = authSchema.table("account_moderation_status", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.userId, { onDelete: "cascade" }),

	// Higher score = more reliable reports. Low score = ghost reported / ignored.
	reportTrustScore: integer("report_trust_score").default(100).notNull(),

	// Null means not banned. A future timestamp means temporary ban.
	bannedUntil: timestamp("banned_until", { withTimezone: true }),

	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const violations = authSchema.table("violations", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),

	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),

	reportedType: reportTypeEnum("reported_type").notNull(),
	reportedId: uuid("reported_id").notNull(),

	reason: text("reason").notNull(),
	moderatorReason: text("moderator_reason"),

	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- TYPE EXPORTS ---
export type Report = InferSelectModel<typeof reports>;
export type NewReport = InferInsertModel<typeof reports>;
