import { Hono } from "hono";

import { healthReport } from "../core/health/health";
import { isShuttingDown } from "../core/health/shutdownState";

export const health = new Hono();

// Used as the readinessProbe target. Checks shuttingDown FIRST, overriding the periodic DB/S3
// flag - this is what makes the pod drop out of the Service's endpoint list the moment shutdown
// starts, before the drain sequence begins closing connections, instead of waiting up to 10s for
// the next health-beat tick to notice.
health.get("/", async (c) => {
	if (isShuttingDown()) {
		return c.json({ ...healthReport, isHealthy: false, shuttingDown: true }, 503);
	}

	if (healthReport.isHealthy) {
		return c.json(healthReport, 200);
	} else {
		return c.json(healthReport, 503);
	}
});

// Used as the livenessProbe target - unconditional 200, process-alive check only, deliberately
// ignoring shuttingDown. A pod that's intentionally draining must not be killed early by its own
// liveness probe; only the readinessProbe (above) should react to a graceful shutdown in progress.
health.get("/live", async (c) => {
	return c.json({ alive: true }, 200);
});
