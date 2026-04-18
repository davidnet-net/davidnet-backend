import { Hono } from "hono";

import { auth } from "./auth";
import { health } from "./health";

export async function registerRoutes(app: Hono) {
	app.route("/health", health);
	app.route("/auth", auth);
}
