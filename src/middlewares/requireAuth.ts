import { and, desc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

import { database } from "../core/database/client";
import { legalRepoSync, userLegalAcceptances } from "../core/database/schema/legal";
import type { Env as MetadataEnv } from "./metadata";
import { upsertUserIp } from "../core/shared/userIpLog";

export type Env = {
	Variables: MetadataEnv["Variables"] & {
		user: {
			id: string;
			jwtID: string;
		};
	};
};

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 uur (of zet op 0 om direct te testen)

export const requireAuth = createMiddleware<Env>(async (c, next) => {
	// 1. JWT / Bearer Token Verificatie
	const authHeader = c.req.header("Authorization");
	const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;

	if (!token) {
		return c.json({ success: false, code: "UNAUTHORIZED" }, 401);
	}

	const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
	if (!ACCESS_SECRET) {
		throw new Error("JWT_ACCESS_SECRET is not configured");
	}

	let userID: string;
	let jwtID: string;

	try {
		const payload = await verify(token, ACCESS_SECRET, "HS256");

		if (payload.type && payload.type !== "access") {
			return c.json({ success: false, code: "INVALID_TOKEN_TYPE" }, 401);
		}

		userID = payload.userID as string;
		jwtID = payload.jwtID as string;

		if (!userID) {
			return c.json({ success: false, code: "INVALID_TOKEN_PAYLOAD" }, 401);
		}

		c.set("user", {
			id: userID,
			jwtID
		});

		void upsertUserIp(userID, c.get("metadata"));
	} catch {
		return c.json({ success: false, code: "INVALID_TOKEN" }, 401);
	}

	// 2. Gebruik c.req.url om de VOLLEDIGE URI-padnaam te bepalen
	// Dit voorkomt dat sub-routers (zoals /social/community-games/feed) de prefix strippen
	const fullPathname = new URL(c.req.url).pathname;

	const isProtectedFeatureRoute =
		fullPathname.startsWith("/social") ||
		fullPathname.startsWith("/workspaces") ||
		fullPathname.startsWith("/websockets");

	// Als het verzoek NIET naar een van deze 3 routes gaat, direct doorlaten!
	if (!isProtectedFeatureRoute) {
		return await next();
	}

	// 3. Legal Acceptance Check UITSLUITEND voor /social/*, /workspaces/* en /websockets/*
	try {
		const latestSync = await database
			.select()
			.from(legalRepoSync)
			.orderBy(desc(legalRepoSync.lastCheckedAt))
			.limit(1);

		if (latestSync.length > 0) {
			const { lastCommitHash, lastCheckedAt } = latestSync[0];

			const acceptance = await database
				.select()
				.from(userLegalAcceptances)
				.where(
					and(
						eq(userLegalAcceptances.userId, userID),
						eq(userLegalAcceptances.commitHash, lastCommitHash)
					)
				)
				.limit(1);

			if (acceptance.length === 0) {
				const now = Date.now();
				const syncTime = new Date(lastCheckedAt).getTime();
				const isGracePeriodActive = now - syncTime < GRACE_PERIOD_MS;

				if (!isGracePeriodActive) {
					if (process.env.NODE_ENV !== "production") {
						return await next();
					}
					return c.json(
						{
							success: false,
							code: "LEGAL_ACCEPTANCE_REQUIRED",
							message:
								"The grace period has expired. You must accept the updated legal terms to continue using the service.",
							currentCommitHash: lastCommitHash
						},
						403
					);
				}
			}
		}
	} catch (err) {
		console.error("[Auth Legal Check Error]:", err);
	}

	await next();
});
