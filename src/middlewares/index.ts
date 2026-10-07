import { Hono } from "hono";
import { logger } from "hono/logger";

import { createRateLimiter } from "./rateLimiter";
import { createMetadata } from "./metadata";
import { ipBanGuard } from "./ipBanGuard";
import { registerCors } from "./cors";
import { sanitizeUnicode } from "./sanitizeUnicode";

export async function registerMiddlewares(app: Hono) {
	await registerCors(app);
	app.use(logger());

	app.use(createMetadata);
	app.use(ipBanGuard);
	app.use(sanitizeUnicode);
	app.use(createRateLimiter(10000, 15 * 60 * 1000));
}
