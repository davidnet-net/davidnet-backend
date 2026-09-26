import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import {
	legalDocuments,
	legalRepoSync,
	userLegalAcceptances
} from "../../core/database/schema/legal";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const legalRoute = new Hono<Env>();

const GITHUB_REPO_OWNER = "davidnet-net";
const GITHUB_REPO_NAME = "legal";
const LEGAL_FILES = [
	"acceptable_use_policy",
	"community_guidelines",
	"contact",
	"cookies",
	"dmca_policy",
	"privacy_policy",
	"security",
	"sub_processors",
	"terms_of_service"
];
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 uur

/**
 * Hulpfunctie om de GitHub repo te synchroniseren als de cache verlopen is (>24u).
 */
async function syncLegalRepoIfNeeded() {
	try {
		const latestSync = await database
			.select()
			.from(legalRepoSync)
			.orderBy(desc(legalRepoSync.lastCheckedAt))
			.limit(1);

		const now = new Date();
		const lastSyncRecord = latestSync[0];

		// Als er binnen de afgelopen 24 uur al gecontroleerd is, doen we niks
		if (
			lastSyncRecord &&
			now.getTime() - new Date(lastSyncRecord.lastCheckedAt).getTime() < CHECK_INTERVAL_MS
		) {
			return lastSyncRecord.lastCommitHash;
		}

		// 1. Haal de nieuwste commit SHA op via GitHub
		const githubRes = await fetch(
			`https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/commits/main`,
			{
				headers: {
					"User-Agent": "Davidnet (contact@davidnet.net)"
				}
			}
		);

		if (!githubRes.ok) {
			// Bij een error vallen we terug op de laatst bekende hash
			return lastSyncRecord?.lastCommitHash ?? null;
		}

		const commitData = (await githubRes.json()) as { sha: string };
		const latestSha = commitData.sha;

		// 2. Update de 'lastCheckedAt' timestamp
		await database.insert(legalRepoSync).values({
			lastCommitHash: latestSha,
			lastCheckedAt: now
		});

		// 3. Als de SHA nieuw is (of dit de allereerste sync is), haal de Markdown bestanden op
		if (!lastSyncRecord || lastSyncRecord.lastCommitHash !== latestSha) {
			for (const slug of LEGAL_FILES) {
				const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/main/${slug}.md`;
				const fileRes = await fetch(rawUrl);

				if (fileRes.ok) {
					const markdownContent = await fileRes.text();

					await database.insert(legalDocuments).values({
						slug,
						content: markdownContent,
						commitHash: latestSha
					});
				}
			}
		}

		return latestSha;
	} catch (error) {
		console.error("[Legal Sync Error]:", error);
		return null;
	}
}

/**
 * 1. CHECK STATUS
 */
legalRoute.get("/status", requireAuth, async (c) => {
	const userID = c.get("user").id;

	// Check automatisch of een refresh nodig is
	const currentCommitHash = await syncLegalRepoIfNeeded();

	if (!currentCommitHash) {
		return c.json({
			success: true,
			needsAcceptance: false,
			currentCommitHash: null
		});
	}

	// Check of de gebruiker de actuele commitHash al geaccepteerd heeft (met Drizzle and())
	const userAcceptance = await database
		.select()
		.from(userLegalAcceptances)
		.where(
			and(
				eq(userLegalAcceptances.userId, userID),
				eq(userLegalAcceptances.commitHash, currentCommitHash)
			)
		)
		.limit(1);

	return c.json({
		success: true,
		needsAcceptance: userAcceptance.length === 0,
		currentCommitHash
	});
});

/**
 * 2. GET DOCUMENTS (Publiek)
 */
legalRoute.get("/documents", async (c) => {
	// Check/refresh ook hier voor de zekerheid
	const currentCommitHash = await syncLegalRepoIfNeeded();

	if (!currentCommitHash) {
		return c.json({ success: false, code: "NO_DOCUMENTS_FOUND" }, 404);
	}

	const docs = await database
		.select()
		.from(legalDocuments)
		.where(eq(legalDocuments.commitHash, currentCommitHash));

	return c.json({
		success: true,
		commitHash: currentCommitHash,
		documents: docs.map((doc) => ({
			slug: doc.slug,
			content: doc.content
		}))
	});
});

/**
 * 3. ACCEPT LEGAL TERMS
 */
legalRoute.post("/accept", requireAuth, async (c) => {
	const userID = c.get("user").id;
	const userAgent = c.req.header("user-agent") || "unknown";
	const ip = c.req.header("x-forwarded-for") || "127.0.0.1";

	const latestSync = await database
		.select()
		.from(legalRepoSync)
		.orderBy(desc(legalRepoSync.lastCheckedAt))
		.limit(1);

	if (latestSync.length === 0) {
		return c.json({ success: false, code: "NO_ACTIVE_LEGAL_VERSION" }, 400);
	}

	const activeCommitHash = latestSync[0].lastCommitHash;

	// Voorkom dubbel accepteren door te controleren of deze al bestaat
	const existingAcceptance = await database
		.select()
		.from(userLegalAcceptances)
		.where(
			and(
				eq(userLegalAcceptances.userId, userID),
				eq(userLegalAcceptances.commitHash, activeCommitHash)
			)
		)
		.limit(1);

	if (existingAcceptance.length > 0) {
		return c.json({
			success: true,
			code: "ALREADY_ACCEPTED",
			commitHash: activeCommitHash
		});
	}

	// Sla de acceptatie op
	await database.insert(userLegalAcceptances).values({
		userId: userID,
		commitHash: activeCommitHash,
		ip,
		userAgent
	});

	return c.json({
		success: true,
		code: "ACCEPTED",
		commitHash: activeCommitHash
	});
});

/**
 * 4. GET ACCEPTANCE HISTORY
 */
legalRoute.get("/history", requireAuth, async (c) => {
	const userID = c.get("user").id;

	const history = await database
		.select()
		.from(userLegalAcceptances)
		.where(eq(userLegalAcceptances.userId, userID))
		.orderBy(desc(userLegalAcceptances.acceptedAt));

	return c.json({
		success: true,
		history: history.map((record) => ({
			commitHash: record.commitHash,
			ip: record.ip,
			userAgent: record.userAgent,
			acceptedAt: record.acceptedAt
		}))
	});
});
