import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { integer, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth";

// --- ENUMS ---
export const reportTypeEnum = authSchema.enum("report_type", ["profile", "short", "game"]);
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

	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

// A ban/unban action taken by a moderator, DSA Art. 17 "statement of reasons" record. Always
// carries a snapshot `reason` (copied from whichever violation justified it, or typed in directly
// when a new violation is created for the ban) so the audit trail survives even if the linked
// violation is later edited or deleted - see routes/support/moderation.ts ban handler.
export const banEventActionEnum = authSchema.enum("ban_event_action", ["ban", "unban"]);

export const banEvents = authSchema.table("ban_events", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),

	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	moderatorId: uuid("moderator_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),

	action: banEventActionEnum("action").notNull(),
	bannedUntil: timestamp("banned_until", { withTimezone: true }),

	violationId: uuid("violation_id").references(() => violations.id, { onDelete: "set null" }),
	reason: text("reason"),

	moderatorIp: text("moderator_ip"),
	moderatorCountryCode: text("moderator_country_code"),

	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// Current (userId, ip) associations seen on authenticated requests - upserted on every sighting
// rather than kept as an unbounded history, so moderators can answer "which IPs does this user
// use" / "which users share this IP" without an ever-growing log table.
export const userIpLog = authSchema.table(
	"user_ip_log",
	{
		userId: uuid("user_id")
			.notNull()
			.references(() => users.userId, { onDelete: "cascade" }),
		ip: text("ip").notNull(),
		countryCode: text("country_code"),
		userAgent: text("user_agent"),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [primaryKey({ columns: [table.userId, table.ip] })]
);

export const bannedIps = authSchema.table("banned_ips", {
	ip: text("ip").primaryKey(),
	moderatorId: uuid("moderator_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	reason: text("reason"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- TYPE EXPORTS ---
export type Report = InferSelectModel<typeof reports>;
export type NewReport = InferInsertModel<typeof reports>;

export type Violation = InferSelectModel<typeof violations>;
export type NewViolation = InferInsertModel<typeof violations>;

export type BanEvent = InferSelectModel<typeof banEvents>;
export type NewBanEvent = InferInsertModel<typeof banEvents>;

export type UserIpLog = InferSelectModel<typeof userIpLog>;
export type NewUserIpLog = InferInsertModel<typeof userIpLog>;

export type BannedIp = InferSelectModel<typeof bannedIps>;
export type NewBannedIp = InferInsertModel<typeof bannedIps>;
