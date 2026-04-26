import type { MiddlewareHandler } from "hono";

// Local store: Map<IP, { count: number, resetTime: number }>
const store = new Map<string, { count: number; resetTime: number }>();

export const createRateLimiter = (limit: number, windowMs: number): MiddlewareHandler => {
	return async (c, next) => {
		const ip = c.req.header("x-forwarded-for") || "anonymous";
		const now = Date.now();
		const record = store.get(ip) || { count: 0, resetTime: now + windowMs };

		// Reset if window has expired
		if (now > record.resetTime) {
			record.count = 0;
			record.resetTime = now + windowMs;
		}

		if (record.count >= limit) {
			return c.json({ error: "Too many requests" }, 429);
		}

		record.count++;
		store.set(ip, record);

		await next();
	};
};
