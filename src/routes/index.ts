import { Hono } from "hono";

import { health } from "./health";
import { auth } from "./auth";

export async function registerRoutes(app: Hono) {
	app.route("/health", health);
	app.route("/auth", auth);
}
