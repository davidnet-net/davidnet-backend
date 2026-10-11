import Redis from "ioredis";

// Defaults to the in-cluster Redis service used in prod; override with REDIS_URL (e.g.
// redis://localhost:6379) to point at a local instance instead, mirroring the GARAGE_ENDPOINT
// pattern in s3.ts.
const REDIS_URL = process.env.REDIS_URL || "redis://redis.redis.svc.cluster.local:6379";

// This pod's identity for Redis lease/lock ownership (quiz phase-timer leader election, quiz-edit
// persistence locks) - POD_NAME is set via the Downward API in the Helm chart; falls back to a
// random id so local dev (where POD_NAME isn't set) still gets a stable-for-this-process identity.
export const POD_ID = process.env.POD_NAME || crypto.randomUUID();

export const redis = new Redis(REDIS_URL, {
	password: process.env.REDIS_PASSWORD,
	// pg-boss-style indefinite retry: a Redis blip should make WS/rate-limit calls fail fast and
	// get retried by the caller's own logic, not queue up forever waiting for a reconnect.
	maxRetriesPerRequest: null
});

// ioredis requires a dedicated connection once put into subscribe mode - it can no longer issue
// any other command on that connection. All pub/sub subscriptions use this duplicate; every other
// command (SET/EVAL/HSET/LPOP/etc.) uses `redis` above.
export const redisSub = redis.duplicate();

export async function closeRedisConnections() {
	await Promise.all([redis.quit(), redisSub.quit()]);
}
