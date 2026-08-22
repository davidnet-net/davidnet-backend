/// <reference types="bun" />

import { Hono } from "hono";
import { websocket } from "hono/bun";

import { closeDbConnection } from "./core/database/client";
import { setupNextHealthBeat, stopHealthBeat } from "./core/health/health";
import { registerMiddlewares } from "./middlewares";
import { registerRoutes } from "./routes";

const app = new Hono();

let server: ReturnType<typeof Bun.serve> | undefined = undefined;

async function init() {
	console.log("[Init]: Starting backend.");

	console.log("[Init]: Starting healthBeat.");
	setupNextHealthBeat();

	console.log("[Init]: Registering middlewares.");
	await registerMiddlewares(app);

	console.log("[Init]: Registering routes.");
	await registerRoutes(app);

	console.log("[Init]: Starting server.");
	server = Bun.serve({
		fetch: app.fetch,
		port: 3020,
		websocket // Now matches the server type perfectly
	});
}

const handleShutdown = async (signal: string) => {
	console.log(`[Shutdown]: Received ${signal}. Closing server...`);

	stopHealthBeat();
	await server?.stop();
	await closeDbConnection();

	console.log("[Shutdown]: Shutdown complete. Exiting.");
	process.exit(0);
};

init();
process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
export default app;
