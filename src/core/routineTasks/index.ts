import { and, eq, inArray, lt } from "drizzle-orm";

import { database } from "../database/client";
import { signupStatus, users } from "../database/schema/auth";

// Matches the grace period advertised in the signup verification email/UI.
const UNVERIFIED_ACCOUNT_TTL_MS = 48 * 60 * 60 * 1000;
const ROUTINE_TASKS_INTERVAL_MS = 15 * 60 * 1000;

let routineTasksTimer: ReturnType<typeof setTimeout> | null = null;

export function setupNextRoutineTasksBeat() {
	if (routineTasksTimer) clearTimeout(routineTasksTimer);

	routineTasksTimer = setTimeout(routineTasksBeat, ROUTINE_TASKS_INTERVAL_MS);
}

export function stopRoutineTasksBeat() {
	if (routineTasksTimer) {
		clearTimeout(routineTasksTimer);
	}
	routineTasksTimer = null;
}

/**
 * Deletes accounts that never verified their email within the advertised grace period.
 * Relies on ON DELETE CASCADE on every users.user_id foreign key to clean up related rows.
 */
async function cleanupUnverifiedAccounts() {
	const cutoff = new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_MS);

	const staleUsers = await database
		.select({ userId: users.userId })
		.from(users)
		.innerJoin(signupStatus, eq(signupStatus.userId, users.userId))
		.where(and(eq(signupStatus.emailVerified, false), lt(users.createdAt, cutoff)));

	if (staleUsers.length === 0) return;

	await database.delete(users).where(
		inArray(
			users.userId,
			staleUsers.map((u) => u.userId)
		)
	);

	console.log(
		`[RoutineTasks]: Deleted ${staleUsers.length} unverified account(s) older than ${UNVERIFIED_ACCOUNT_TTL_MS / (60 * 60 * 1000)}h.`
	);
}

async function routineTasksBeat() {
	try {
		await cleanupUnverifiedAccounts();
	} catch (error) {
		console.error("Error running routine tasks beat:", error);
	} finally {
		if (routineTasksTimer !== null) {
			setupNextRoutineTasksBeat();
		}
	}
}
