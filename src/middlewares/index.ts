import { Hono } from "hono";
import { logger } from "hono/logger";

import { createRateLimiter } from "./rateLimiter";
import { createMetadata } from "./metadata";
import { registerCors } from "./cors";
import { sanitizeUnicode } from "./sanitizeUnicode";

export async function registerMiddlewares(app: Hono) {
	await registerCors(app);
	app.use(logger());

	app.use(createMetadata);
	app.use(sanitizeUnicode);
	app.use(createRateLimiter(1000, 15 * 60 * 1000));
}
