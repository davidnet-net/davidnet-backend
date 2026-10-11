import { database } from "../database/client";
import { boss } from "../queue/boss";
import { QUEUE } from "../queue/jobs";
import { auditLogs } from "../database/schema/schema";

export async function createUserAuditLog(userID: string, message: string) {
	try {
		// Insert the audit log entry - stays synchronous, it's a fast local write.
		await database.insert(auditLogs).values({
			userId: userID,
			message: message,
			createdAt: new Date()
		});

		const blockedPhrases = ["attempt", "Account created."];
		const shouldSendMail: boolean = !blockedPhrases.some((phrase) => message.includes(phrase));
		if (shouldSendMail) {
			// Email lookup/send moves to the worker (see src/worker.ts) - the job carries only the
			// userId, so the worker resolves the email at run time rather than baking a possibly-stale
			// address into the payload.
			await boss.send(QUEUE.AUDIT_LOG_EMAIL, { userId: userID, message });
		}
	} catch (error) {
		console.error("[Audits]: Failed to create user audit log:", error);
		throw error;
	}
}
