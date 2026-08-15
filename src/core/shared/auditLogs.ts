import { eq } from "drizzle-orm"; // 1. Import 'eq' from drizzle-orm
import { auditLogTemplateEmail } from "../../emailTemplates/auditLog";
import { database } from "../database/client";
import { auditLogs, users } from "../database/schema/schema"; // 2. Import 'users' table
import { sendEmail } from "../utils/emails";

export async function createUserAuditLog(userID: string, message: string) {
	try {
		// Insert the audit log entry
		await database.insert(auditLogs).values({
			userId: userID,
			message: message,
			createdAt: new Date()
		});

		const blockedPhrases = ["attempt", "Account created."];
		const shouldSendMail: boolean = !blockedPhrases.some((phrase) => message.includes(phrase));
		if (shouldSendMail) {
			// 3. Fetch the user's email from the database using the userID
			const userRecord = await database.query.users.findFirst({
				where: eq(users.userId, userID),
				columns: {
					email: true
				}
			});

			if (!userRecord || !userRecord.email) {
				throw new Error(`User with ID ${userID} not found or has no email address.`);
			}

			const htmlContent = auditLogTemplateEmail.replaceAll("{{message}}", message);

			// 4. Pass the fetched email variable to sendEmail
			await sendEmail(userRecord.email, "Davidnet - Audit log", htmlContent);
		}
	} catch (error) {
		console.error("[Audits]: Failed to create user audit log:", error);
		throw error;
	}
}
