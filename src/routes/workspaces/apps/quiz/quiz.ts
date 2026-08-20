import { Hono } from "hono";
import { Env } from "../../../../middlewares/requireAuth";
import { createRateLimiter } from "../../../../middlewares/rateLimiter";
import { requirePerm } from "../../../../middlewares/requirePerm";

export const quiz = new Hono<Env>();

quiz.post("/", createRateLimiter(15, 15 * 60 * 1000), requirePerm("quiz:create"), async (c) => {
	return c.json({
		success: true,
		code: "TEST"
	});
});
