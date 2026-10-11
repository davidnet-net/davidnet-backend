/// <reference types="bun" />

import { Hono } from "hono";
import { websocket } from "hono/bun";

import { closeDbConnection } from "./core/database/client";
import { setupNextHealthBeat, stopHealthBeat } from "./core/health/health";
import { markShuttingDown } from "./core/health/shutdownState";
import { boss, ensureQueues } from "./core/queue/boss";
import { closeRedisConnections } from "./core/shared/redis";
import { registerMiddlewares } from "./middlewares";
import { registerRoutes } from "./routes";
import { drainAllWebsockets } from "./routes/websockets/drain";

const app = new Hono();

let server: ReturnType<typeof Bun.serve> | undefined = undefined;

// How long to wait after markShuttingDown() before touching any connection - gives the
// readinessProbe time to fail and the Service/Traefik time to remove this pod from its endpoint
// list, so the WS drain below doesn't race new traffic still being routed here.
const READINESS_PROPAGATION_DELAY_MS = 3000;

async function init() {
	console.log("[Init]: Starting backend.");

	console.log("[Init]: Starting healthBeat.");
	setupNextHealthBeat();

	console.log("[Init]: Starting job queue producer.");
	await boss.start();
	await ensureQueues();

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const handleShutdown = async (signal: string) => {
	console.log(`[Shutdown]: Received ${signal}. Starting graceful shutdown.`);

	// 1. Fail the readinessProbe immediately - this is what drops the pod from the Service's
	// endpoint list before anything else happens.
	markShuttingDown();

	// 2. Give that removal time to propagate before touching any connection.
	await sleep(READINESS_PROPAGATION_DELAY_MS);

	// 3. Release any Redis leases/locks this pod holds and close local WS connections with a
	// reconnect hint, so clients (and, for owned sessions, another pod's watchdog) can move on
	// quickly instead of waiting out a lease TTL or a dead socket timeout.
	console.log("[Shutdown]: Draining websockets.");
	await drainAllWebsockets();

	stopHealthBeat();

	// 4. Stop accepting new HTTP requests, let in-flight ones finish.
	await server?.stop();

	// 5. Close remaining backing connections.
	await boss.stop();
	await closeDbConnection();
	await closeRedisConnections();

	console.log("[Shutdown]: Complete. Exiting.");
	process.exit(0);
};

init();
process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
export default app;
