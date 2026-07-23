import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { userPrivacyPreferences } from "../../core/database/schema/schema";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const privacy = new Hono<Env>();

privacy.get("/preferences", requireAuth, async (c) => {
	const userID = c.get("user").id;

	const result = await database
		.select()
		.from(userPrivacyPreferences)
		.where(eq(userPrivacyPreferences.userId, userID))
		.limit(1);

	if (result.length === 0) {
		return c.json({ success: false, code: "PRIVACY_PREFERENCES_NOT_FOUND" }, 404);
	}

	const p = result[0];

	return c.json({
		languageVisibility: p.languageVisibility,
		timezoneVisibility: p.timezoneVisibility,
		locationVisibility: p.locationVisibility,
		emailVisibility: p.emailVisibility
	});
});
