import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { users } from "../../core/database/schema/schema";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const me = new Hono<Env>();

me.get("/", requireAuth, async (c) => {
	const userID = c.get("user").id;

	const userResult = await database.select().from(users).where(eq(users.userId, userID)).limit(1);

	if (userResult.length === 0) {
		return c.json({ success: false, code: "USER_NOT_FOUND" }, 404);
	}

	const u = userResult[0];

	return c.json({
		userID: u.userId,
		username: u.username,
		displayName: u.displayName,
		avatarURL: u.avatarUrl,
		bannerURL: u.bannerUrl,
		description: u.description,
		email: u.email,
		countryCode: u.countryCode,
		location: u.location
	});
});
