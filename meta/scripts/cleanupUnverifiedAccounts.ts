import { and, eq, inArray, lt } from "drizzle-orm";

import { closeDbConnection, database } from "../../src/core/database/client";
import { signupStatus, users } from "../../src/core/database/schema/auth";

// Matches the grace period advertised in the signup verification email/UI. Relies on ON DELETE
// CASCADE on every users.user_id foreign key to clean up related rows.
const UNVERIFIED_ACCOUNT_TTL_MS = 48 * 60 * 60 * 1000;

async function run() {
	const cutoff = new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_MS);

	const staleUsers = await database
		.select({ userId: users.userId })
		.from(users)
		.innerJoin(signupStatus, eq(signupStatus.userId, users.userId))
		.where(and(eq(signupStatus.emailVerified, false), lt(users.createdAt, cutoff)));

	if (staleUsers.length === 0) {
		console.log("[CleanupUnverifiedAccounts]: Nothing to clean up.");
		return;
	}

	await database.delete(users).where(
		inArray(
			users.userId,
			staleUsers.map((u) => u.userId)
		)
	);

	console.log(
		`[CleanupUnverifiedAccounts]: Deleted ${staleUsers.length} unverified account(s) older than ${UNVERIFIED_ACCOUNT_TTL_MS / (60 * 60 * 1000)}h.`
	);
}

run()
	.then(async () => {
		await closeDbConnection();
		process.exit(0);
	})
	.catch(async (err) => {
		console.error("[CleanupUnverifiedAccounts]: Failed:", err);
		await closeDbConnection();
		process.exit(1);
	});
