import { Hono } from "hono";
import { logger } from "hono/logger";

export async function registerMiddlewares(app: Hono) {
	app.use(logger());
}
