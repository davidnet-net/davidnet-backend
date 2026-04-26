import { Hono } from "hono";
import { logger } from "hono/logger";
import { createRateLimiter } from "./rateLimiter";

export async function registerMiddlewares(app: Hono) {
	app.use(logger());
	app.use(createRateLimiter(1000, 15 * 60 * 1000));
}
