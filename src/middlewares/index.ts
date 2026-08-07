import { Hono } from "hono";
import { logger } from "hono/logger";

import { createRateLimiter } from "./rateLimiter";
import { createMetadata } from "./metadata";
import { cors } from "hono/cors";

export async function registerMiddlewares(app: Hono) {
	app.use(
		"*",
		cors({
			origin: (origin) => {
				if (!origin) return null;

				try {
					const url = new URL(origin);
					const hostname = url.hostname;

					// Check davidnet.net and its subdomains
					if (hostname === "davidnet.net" || hostname.endsWith(".davidnet.net")) {
						return origin;
					}

					// Check davidnet.internal and its subdomains
					if (hostname === "davidnet.internal" || hostname.endsWith(".davidnet.internal")) {
						return origin;
					}
				} catch (e) {
					// Fallback if the origin header is malformed
					return null;
				}

				return null;
			},
			credentials: true,

			allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			exposeHeaders: ["x-correlation-id"],
			allowHeaders: [
				"Content-Type",
				"Authorization",
				"x-tab-session-id",
				"x-correlation-id",
				"x-signuptoken"
			]
		})
	);
	app.use(logger());
	app.use(createMetadata);
	app.use(createRateLimiter(1000, 15 * 60 * 1000));
}
