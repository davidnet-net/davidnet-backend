import type { Context, MiddlewareHandler } from "hono";

export type RateLimitStatus = {
	limit: number;
	remaining: number;
	resetAt: number;
};

export type RateLimiterOptions = {
	// Defaults to the request's IP (the original behavior). Pass a custom key to scope the bucket
	// differently, e.g. per authenticated user, or per user+resource so one hot resource can't burn
	// through a budget shared with everything else that key would otherwise cover.
	keyFn?: (c: Context) => string;
};

// A rate limiter whose bucket can also be inspected on demand via getStatus(key), without
// consuming a request - used to embed "how much budget is left" into a success response body so
// callers (e.g. a sandboxed game through the SDK bridge) can self-throttle before ever hitting 429.
export type RateLimiter = MiddlewareHandler & {
	getStatus: (key: string) => RateLimitStatus;
};

export const createRateLimiter = (
	limit: number,
	windowMs: number,
	options: RateLimiterOptions = {}
): RateLimiter => {
	const store = new Map<string, { count: number; resetTime: number }>();
	const keyFn = options.keyFn ?? ((c: Context) => c.get("metadata").ip);

	// Without this, every distinct key this limiter has ever seen - every IP, or for a per-user
	// limiter every user+game/user+resource pair - stays in `store` forever, even long after its
	// window closed. The map only ever grows, for the life of the process. Sweep out anything
	// whose window has already expired; it's always safe to delete, since the next request for
	// that key would just start a fresh window from scratch anyway.
	const sweepIntervalMs = Math.max(windowMs, 60_000);
	const sweepTimer = setInterval(() => {
		const now = Date.now();
		for (const [key, record] of store) {
			if (now > record.resetTime) store.delete(key);
		}
	}, sweepIntervalMs);
	sweepTimer.unref?.();

	const getStatus = (key: string): RateLimitStatus => {
		const now = Date.now();
		const record = store.get(key);
		if (!record || now > record.resetTime) {
			return { limit, remaining: limit, resetAt: now + windowMs };
		}
		return { limit, remaining: Math.max(0, limit - record.count), resetAt: record.resetTime };
	};

	const middleware: MiddlewareHandler = async (c, next) => {
		const key = keyFn(c);
		const now = Date.now();
		let record = store.get(key);

		// Reset if window has expired
		if (!record || now > record.resetTime) {
			record = { count: 0, resetTime: now + windowMs };
		}

		if (record.count >= limit) {
			store.set(key, record);
			c.header("X-RateLimit-Limit", String(limit));
			c.header("X-RateLimit-Remaining", "0");
			c.header("X-RateLimit-Reset", String(record.resetTime));
			return c.json(
				{
					success: false,
					code: "RATE_LIMITED",
					message: "Too many requests",
					retryAfterMs: record.resetTime - now,
					rateLimit: { limit, remaining: 0, resetAt: record.resetTime }
				},
				429
			);
		}

		record.count++;
		store.set(key, record);

		c.header("X-RateLimit-Limit", String(limit));
		c.header("X-RateLimit-Remaining", String(Math.max(0, limit - record.count)));
		c.header("X-RateLimit-Reset", String(record.resetTime));

		await next();
	};

	return Object.assign(middleware, { getStatus });
};
