import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { database } from "../core/database/client";
import { bannedIps } from "../core/database/schema/schema";
import type { Env as MetadataEnv } from "./metadata";

// Runs for every request, authenticated or not - an IP ban blocks the whole backend, not just the
// routes that happen to check account bans. Must run after createMetadata (needs metadata.ip) and
// before anything else that would do real work.
export const ipBanGuard = createMiddleware<MetadataEnv>(async (c, next) => {
	const ip = c.get("metadata").ip;

	if (ip && ip !== "Unknown IP") {
		try {
			const [banned] = await database
				.select()
				.from(bannedIps)
				.where(eq(bannedIps.ip, ip))
				.limit(1);

			if (banned) {
				return c.json(
					{ success: false, code: "IP_BANNED", reason: banned.reason ?? null },
					403
				);
			}
		} catch (error) {
			console.error("[IpBanGuard]: Failed to check IP ban status:", error);
		}
	}

	await next();
});
