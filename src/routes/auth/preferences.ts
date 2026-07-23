import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { userPreferences } from "../../core/database/schema/schema";
import { type Env, requireAuth } from "../../middlewares/requireAuth";
import { updatePreferencesSchema } from "../../core/requestSchemas/preferences";
import { sValidator } from "@hono/standard-validator";

export const preferences = new Hono<Env>();

preferences.get("/", requireAuth, async (c) => {
	const userID = c.get("user").id;

	const result = await database
		.select()
		.from(userPreferences)
		.where(eq(userPreferences.userId, userID))
		.limit(1);

	if (result.length === 0) {
		return c.json({ success: false, code: "PREFERENCES_NOT_FOUND" }, 404);
	}

	const p = result[0];

	return c.json({
		theme: p.theme,
		language: p.language,
		timezone: p.timezone,
		firstDayOfWeek: p.firstDayOfWeek,
		dateFormat: p.dateFormat
	});
});

preferences.patch("/", requireAuth, sValidator("json", updatePreferencesSchema), async (c) => {
	const userID = c.get("user").id;
	const data = c.req.valid("json");

	if (Object.keys(data).length === 0) {
		return c.json(
			{
				success: false,
				code: "BAD_REQUEST",
				message: "No valid fields provided to update."
			},
			400
		);
	}

	const result = await database
		.update(userPreferences)
		.set(data)
		.where(eq(userPreferences.userId, userID))
		.returning();

	if (result.length === 0) {
		return c.json({ success: false, code: "PREFERENCES_NOT_FOUND" }, 404);
	}

	return c.json({
		success: true,
		preferences: result[0]
	});
});
