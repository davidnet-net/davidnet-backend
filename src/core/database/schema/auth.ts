import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");

// --- ENUMS ---
export const themeEnum = authSchema.enum("theme_type", ["dark", "light", "contrast", "system"]);

export const visibilityEnum = authSchema.enum("visibility_type", [
	"private",
	"organizations",
	"connections",
	"organizations_and_connections",
	"public"
]);

// --- TABLES ---
export const users = authSchema.table("users", {
	userId: uuid("user_id")
		.primaryKey()
		.default(sql`uuidv7()`),
	username: text("username").notNull().unique(),
	password: text("password").notNull(),
	displayName: text("display_name").notNull(),
	avatarUrl: text("avatar_url"),
	bannerUrl: text("banner_url"),
	description: text("description"),
	email: text("email").notNull().unique(),
	countryCode: text("country_code"),
	location: text("location"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const securityConfig = authSchema.table("user_security", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.userId, { onDelete: "cascade" }),

	// Indicates whether TOTP 2FA is active for the user
	authenticatorEnabled: boolean("authenticator_enabled").default(false).notNull(),

	// The secret key (base32 string) shared between backend & app
	authenticatorSeed: text("authenticator_seed"),

	// Hashed single-use recovery/backup codes
	backupCodes: jsonb("backup_codes"),

	// Prevents replay attacks by tracking the last timestamp window used
	lastUsedTotpWindow: integer("last_used_totp_window")
});

export const signupStatus = authSchema.table("signup_status", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.userId, { onDelete: "cascade" }),
	emailVerified: boolean("email_verified").default(false).notNull(),
	emailVerificationToken: uuid("email_verification_token")
		.default(sql`uuidv4()`)
		.notNull(),
	preferencesStepCompleted: boolean("preferences_step_completed").default(false).notNull(),
	signupToken: uuid("signup_token").default(sql`uuidv4()`)
});

export const userPreferences = authSchema.table("user_preferences", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.userId, { onDelete: "cascade" }),
	theme: themeEnum("theme").default("system").notNull(),
	language: text("language").default("en").notNull(),
	timezone: text("timezone").default("UTC").notNull(),
	firstDayOfWeek: text("first_day_of_week").default("monday").notNull(),
	dateFormat: text("date_format").default("YYYY-MM-DD").notNull()
});

export const userPrivacyPreferences = authSchema.table("user_privacy_preferences", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.userId, { onDelete: "cascade" }),
	languageVisibility: visibilityEnum("language_visibility").default("private").notNull(),
	timezoneVisibility: visibilityEnum("timezone_visibility").default("private").notNull(),
	locationVisibility: visibilityEnum("location_visibility").default("private").notNull(),
	emailVisibility: visibilityEnum("email_visibility").default("private").notNull()
});

export const sessionTokens = authSchema.table("session_tokens", {
	jwtId: uuid("jwt_id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	ip: text("ip").notNull(),
	userAgent: text("user_agent").notNull(),
	countryCode: text("country_code").notNull()
});

export const auditLogs = authSchema.table("audit_logs", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	message: text("message").notNull()
});

export const internalAccess = authSchema.table("internal_access", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.userId, { onDelete: "cascade" }),
	internalAccess: boolean("internal_access").default(false).notNull(),
	vpnAccess: boolean("vpn_access").default(false).notNull(),
	dbsAccess: boolean("dbs_access").default(false).notNull(),
	supportAccess: boolean("support_access").default(false).notNull(),
	monitoringAccess: boolean("monitoring_access").default(false).notNull(),
	developerAccess: boolean("developer_access").default(false).notNull()
});

export type user = InferSelectModel<typeof users>;
export type newUser = InferInsertModel<typeof users>;

export type userPreferences = InferSelectModel<typeof userPreferences>;
export type newUserPreferences = InferInsertModel<typeof userPreferences>;

export type userPrivacyPreferences = InferSelectModel<typeof userPrivacyPreferences>;
export type newUserPrivacyPreferences = InferInsertModel<typeof userPrivacyPreferences>;

export type userToken = InferSelectModel<typeof sessionTokens>;
export type newUserToken = InferInsertModel<typeof sessionTokens>;

export type auditLog = InferSelectModel<typeof auditLogs>;
export type newAuditLog = InferInsertModel<typeof auditLogs>;

export type securityConfig = InferSelectModel<typeof securityConfig>;
export type newsecurityConfig = InferInsertModel<typeof securityConfig>;

export type internalAccess = InferSelectModel<typeof internalAccess>;
export type newInternalAccess = InferInsertModel<typeof internalAccess>;
