import { database } from "../database/client";
import { auditLogs } from "../database/schema/schema";

export async function createUserAuditLog(userID: string, message: string) {
	try {
		await database.insert(auditLogs).values({
			userId: userID,
			message: message,
			createdAt: new Date()
		});
	} catch (error) {
		console.error("[Audits]: Failed to create user audit log:", error);
		throw error;
	}
}
