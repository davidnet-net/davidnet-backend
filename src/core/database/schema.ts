import { pgSchema, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import { type InferSelectModel, type InferInsertModel } from "drizzle-orm";

//! Make sure to keep schemaFilter up to date inside the drizzle config file!
//! DO NOT PUT LOGIC INSIDE THIS FILE!

export const authSchema = pgSchema("auth");

// --- ENUMS ---
export const themeEnum = authSchema.enum("theme_type", [
    "dark", "light", "contrast", "system"
]);

export const visibilityEnum = authSchema.enum("visibility_type", [
    "private", "organizations", "connections", "organizations_and_connections", "public"
]);

// --- TABLES ---
export const users = authSchema.table("users", {
    userId: uuid("user_id").primaryKey(), // Expects UUIDv7
    username: text("username").notNull().unique(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    bannerUrl: text("banner_url"),
    description: text("description"),
    email: text("email").notNull().unique(),
    countryCode: text("country_code"),
    location: text("location"),
    isAdmin: boolean("is_admin").default(false).notNull(),
    isInternal: boolean("is_internal").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userPreferences = authSchema.table("user_preferences", {
    userId: uuid("user_id")
        .primaryKey()
        .references(() => users.userId, { onDelete: "cascade" }),
    theme: themeEnum("theme").default("system").notNull(),
    language: text("language").default("en").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    firstDayOfWeek: text("first_day_of_week").default("monday").notNull(),
    dateFormat: text("date_format").default("YYYY-MM-DD").notNull(),
});

export const userPrivacyPreferences = authSchema.table("user_privacy_preferences", {
    userId: uuid("user_id")
        .primaryKey()
        .references(() => users.userId, { onDelete: "cascade" }),
    languageVisibility: visibilityEnum("language_visibility").default("private").notNull(),
    timezoneVisibility: visibilityEnum("timezone_visibility").default("private").notNull(),
    locationVisibility: visibilityEnum("location_visibility").default("private").notNull(),
    emailVisibility: visibilityEnum("email_visibility").default("private").notNull(),
});

export const userTokens = authSchema.table("user_tokens", {
    jwtId: uuid("jwt_id").primaryKey(), // Expects UUIDv7
    userId: uuid("user_id")
        .notNull()
        .references(() => users.userId, { onDelete: "cascade" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type UserPreferences = InferSelectModel<typeof userPreferences>;
export type NewUserPreferences = InferInsertModel<typeof userPreferences>;

export type UserPrivacyPreferences = InferSelectModel<typeof userPrivacyPreferences>;
export type NewUserPrivacyPreferences = InferInsertModel<typeof userPrivacyPreferences>;

export type UserToken = InferSelectModel<typeof userTokens>;
export type NewUserToken = InferInsertModel<typeof userTokens>;