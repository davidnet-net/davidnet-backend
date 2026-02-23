import { Hono } from 'hono'
import { setupNextHealthBeat, stopHealthBeat } from './core/health/health'
import { registerRoutes } from './routes';
import { closeDbConnection } from './core/database/client';


const app = new Hono()
let server: Bun.Server<undefined> | undefined = undefined;

async function init() {
  console.log("[Init]: Starting backend.");

  console.log("[Init]: Starting healthBeat.");
  setupNextHealthBeat();

  console.log("[Init]: Registering routes.")
  await registerRoutes(app);

  server = Bun.serve({
    fetch: app.fetch,
    port: 3020,
  });
}


/**
 * @param {string} signal - The OS signal received.
 */
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
export default app