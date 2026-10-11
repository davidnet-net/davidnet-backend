import type { Context, MiddlewareHandler } from "hono";

import { redis } from "../core/shared/redis";

export type RateLimitStatus = {
	limit: number;
	remaining: number;
	resetAt: number;
};

export type RateLimiterOptions = {
	// Namespaces this limiter's Redis keys against every other limiter in the process. Required
	// because the store is now shared across every pod (and every other limiter instance in this
	// same pod) - unlike the old in-process Map, which was private per createRateLimiter() call and
	// so never needed a name to avoid colliding with another call's keys.
	name: string;
	// Defaults to the request's IP (the original behavior). Pass a custom key to scope the bucket
	// differently, e.g. per authenticated user, or per user+resource so one hot resource can't burn
	// through a budget shared with everything else that key would otherwise cover.
	keyFn?: (c: Context) => string;
};

// A rate limiter whose bucket can also be inspected on demand via getStatus(key), without
// consuming a request - used to embed "how much budget is left" into a success response body so
// callers (e.g. a sandboxed game through the SDK bridge) can self-throttle before ever hitting 429.
export type RateLimiter = MiddlewareHandler & {
	getStatus: (key: string) => Promise<RateLimitStatus>;
};

// Atomically increments the bucket's counter, setting its expiry only on the very first hit in a
// window (so a late request in an existing window doesn't reset its own TTL). Returns [count, ttl
// in ms]. Consuming (increment) and inspecting (getStatus, below) are two separate scripts rather
// than one script with a "consume?" flag, so getStatus can never accidentally increment - same
// guarantee the old Map-based implementation gave by construction (it just read the record).
const INCR_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { count, ttl }
`;

// Read-only: GET+PTTL only, never INCR. PTTL on a key with no TTL (shouldn't happen here, since
// every key INCR_SCRIPT creates gets a PEXPIRE in the same call) returns -1; treated as "no record"
// defensively.
const STATUS_SCRIPT = `
local count = redis.call("GET", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if not count or ttl < 0 then
  return { 0, -1 }
end
return { tonumber(count), ttl }
`;

export const createRateLimiter = (
	limit: number,
	windowMs: number,
	options: RateLimiterOptions
): RateLimiter => {
	const keyFn = options.keyFn ?? ((c: Context) => c.get("metadata").ip);
	const redisKey = (key: string) => `rl:${options.name}:${key}`;

	const getStatus = async (key: string): Promise<RateLimitStatus> => {
		const now = Date.now();
		const [count, ttl] = (await redis.eval(STATUS_SCRIPT, 1, redisKey(key))) as [number, number];

		if (ttl < 0) {
			return { limit, remaining: limit, resetAt: now + windowMs };
		}
		return { limit, remaining: Math.max(0, limit - count), resetAt: now + ttl };
	};

	const middleware: MiddlewareHandler = async (c, next) => {
		const key = keyFn(c);
		const now = Date.now();

		const [count, ttl] = (await redis.eval(INCR_SCRIPT, 1, redisKey(key), String(windowMs))) as [
			number,
			number
		];
		const resetAt = now + ttl;

		if (count > limit) {
			c.header("X-RateLimit-Limit", String(limit));
			c.header("X-RateLimit-Remaining", "0");
			c.header("X-RateLimit-Reset", String(resetAt));
			return c.json(
				{
					success: false,
					code: "RATE_LIMITED",
					message: "Too many requests",
					retryAfterMs: resetAt - now,
					rateLimit: { limit, remaining: 0, resetAt }
				},
				429
			);
		}

		c.header("X-RateLimit-Limit", String(limit));
		c.header("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
		c.header("X-RateLimit-Reset", String(resetAt));

		await next();
	};

	return Object.assign(middleware, { getStatus });
};
