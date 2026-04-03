import { Hono } from "hono";

import { healthReport } from "../core/health/health";

export const health = new Hono();

health.get("/", async (c) => {
	if (healthReport.isHealthy) {
		return c.json(healthReport, 200);
	} else {
		return c.json(healthReport, 503);
	}
});
