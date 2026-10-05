import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Env, requireAuth } from "../../middlewares/requireAuth";
import { createRateLimiter } from "../../middlewares/rateLimiter";
import { sValidator } from "@hono/standard-validator";
import { feedbackSchema } from "../../core/requestSchemas/support";
import { database } from "../../core/database/client";
import { feedbackTable } from "../../core/database/schema/support";
import { internalAccess, users } from "../../core/database/schema/schema";

export const feedback = new Hono<Env>();

// Max rows returned per request - this is an internal review list, not a paginated feed, so a
// generous flat cap (matching the style of the other /support/moderation/*/all endpoints) is
// enough to keep the response bounded as submissions accumulate over time.
const MAX_FEEDBACK_LIST_SIZE = 300;

// --- HELPER: CHECK MODERATOR/SUPPORT PERMISSIONS (same bar as support/moderation.ts) ---
async function isModerator(userId: string): Promise<boolean> {
	const [access] = await database
		.select({
			internalAccess: internalAccess.internalAccess,
			supportAccess: internalAccess.supportAccess
		})
		.from(internalAccess)
		.where(eq(internalAccess.userId, userId))
		.limit(1);

	return Boolean(access && access.internalAccess && access.supportAccess);
}

feedback.post(
	"/",
	createRateLimiter(10, 15 * 60 * 1000),
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

// --- GET ALL SUBMITTED FEEDBACK (support staff only) ---
feedback.get("/all", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	try {
		// feedbackId is a uuidv7 (time-ordered), so sorting by it is equivalent to sorting by
		// insertion time without needing a dedicated created_at column.
		const allFeedback = await database
			.select({
				feedbackId: feedbackTable.feedbackId,
				userId: feedbackTable.userId,
				data: feedbackTable.data,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl
			})
			.from(feedbackTable)
			.leftJoin(users, eq(feedbackTable.userId, users.userId))
			.orderBy(desc(feedbackTable.feedbackId))
			.limit(MAX_FEEDBACK_LIST_SIZE);

		return c.json({
			success: true,
			code: "SUCCESS",
			feedback: allFeedback
		});
	} catch (error) {
		console.error("Failed to fetch feedback:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});
