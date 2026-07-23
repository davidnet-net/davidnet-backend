import type { MiddlewareHandler } from "hono";

export const createRateLimiter = (limit: number, windowMs: number): MiddlewareHandler => {
	const store = new Map<string, { count: number; resetTime: number }>();

	return async (c, next) => {
		const ip = c.get("metadata").ip;
		console.log(ip);
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
