import { Hono } from "hono";
import { type Env, requireAuth } from "../../middlewares/requireAuth";
import { createRateLimiter } from "../../middlewares/rateLimiter";
import { sValidator } from "@hono/standard-validator";
import { feedbackSchema } from "../../core/requestSchemas/support";
import { database } from "../../core/database/client";
import { feedbackTable } from "../../core/database/schema/support";

export const feedback = new Hono<Env>();

feedback.post(
	"/",
	createRateLimiter(3, 15 * 60 * 1000),
	sValidator("json", feedbackSchema),
	requireAuth,
	async (c) => {
		const userID = c.get("user").id;
		const data = c.req.valid("json");

		await database.insert(feedbackTable).values({
			userId: userID,
			data: data
		});

		return c.json({
			success: true,
			code: "FEEDBACK_SUBMITTED"
		});
	}
);
