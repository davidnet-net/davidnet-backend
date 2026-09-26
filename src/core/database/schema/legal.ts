import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth"; // Pas het pad naar auth.ts aan indien nodig

// 1. Tabel om de binnengehaalde Markdown bestanden op te slaan
export const legalDocuments = authSchema.table("legal_documents", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	// Bijv: 'terms_of_service', 'privacy_policy', 'cookie_policy'
	slug: text("slug").notNull(),
	// De ruwe Markdown inhoud
	content: text("content").notNull(),
	// De GitHub commit hash ten tijde van de synchronisatie
	commitHash: text("commit_hash").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// 2. Tabel om de synchronisatiestatus van de GitHub repository op te slaan
export const legalRepoSync = authSchema.table("legal_repo_sync", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	// De laatst opgehaalde commit hash van de hele repo
	lastCommitHash: text("last_commit_hash").notNull(),
	lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).defaultNow().notNull()
});

// 3. Tabel om vast te leggen welke gebruiker welke commit heeft geaccepteerd
export const userLegalAcceptances = authSchema.table("user_legal_acceptances", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	// Sla de specifieke commit_hash op die op het moment van akkoord actief was
	commitHash: text("commit_hash").notNull(),
	acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
	ip: text("ip").notNull(),
	userAgent: text("user_agent").notNull()
});

// --- TYPE EXPORTS ---
export type LegalDocument = InferSelectModel<typeof legalDocuments>;
export type NewLegalDocument = InferInsertModel<typeof legalDocuments>;

export type LegalRepoSync = InferSelectModel<typeof legalRepoSync>;
export type NewLegalRepoSync = InferInsertModel<typeof legalRepoSync>;

export type UserLegalAcceptance = InferSelectModel<typeof userLegalAcceptances>;
export type NewUserLegalAcceptance = InferInsertModel<typeof userLegalAcceptances>;
