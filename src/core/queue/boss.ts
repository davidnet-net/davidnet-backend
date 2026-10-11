import PgBoss from "pg-boss";

import { QUEUE } from "./jobs";

export const boss = new PgBoss(process.env.DATABASE_URL!);

// pg-boss v10 requires every queue to be explicitly created (with its retry policy) before it can
// be sent to or worked - createQueue is an idempotent upsert, safe to call on every boot. Called
// once from both src/index.ts (producer side) and src/worker.ts (consumer side) after boss.start(),
// so either process can come up first without the other missing a queue definition.
export async function ensureQueues() {
	// Email jobs: SMTP transience is common and nothing is waiting synchronously on these, so retry
	// generously with backoff.
	const emailRetry = { retryLimit: 5, retryDelay: 10, retryBackoff: true };
	await boss.createQueue(QUEUE.PASSWORD_RESET_EMAIL, {
		name: QUEUE.PASSWORD_RESET_EMAIL,
		...emailRetry
	});
	await boss.createQueue(QUEUE.SIGNUP_VERIFY_EMAIL, {
		name: QUEUE.SIGNUP_VERIFY_EMAIL,
		...emailRetry
	});
	await boss.createQueue(QUEUE.AUDIT_LOG_EMAIL, { name: QUEUE.AUDIT_LOG_EMAIL, ...emailRetry });

	// Video duration probe failures are mostly deterministic (corrupt file, unsupported codec), and
	// the `shorts` row already has a safe fallback duration in place - fewer retries, shorter delay.
	await boss.createQueue(QUEUE.VIDEO_DURATION_PROBE, {
		name: QUEUE.VIDEO_DURATION_PROBE,
		retryLimit: 3,
		retryDelay: 15,
		retryBackoff: true
	});
}
