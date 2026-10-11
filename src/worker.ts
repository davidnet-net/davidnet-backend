/// <reference types="bun" />

// Separate entrypoint, deployed as its own pod (see charts/davidnet-backend/templates/
// worker-deployment.yaml) - a pg-boss worker registered in the same process as the HTTP server
// would still run its job handlers on that process's single-threaded event loop, which defeats
// the point of queueing CPU/IO-bound work off the API in the first place.
import { eq } from "drizzle-orm";
import fs from "fs/promises";
import { getVideoDurationInSeconds } from "get-video-duration";
import os from "os";
import path from "path";

import { closeDbConnection, database } from "./core/database/client";
import { shorts, users } from "./core/database/schema/schema";
import { boss, ensureQueues } from "./core/queue/boss";
import {
	AuditLogEmailJob,
	PasswordResetEmailJob,
	QUEUE,
	SignupVerifyEmailJob,
	VideoDurationProbeJob
} from "./core/queue/jobs";
import { getFromBucket } from "./core/shared/s3";
import { loadEmailTemplate, sendEmail } from "./core/utils/emails";
import { auditLogTemplateEmail } from "./emailTemplates/auditLog";
import { passwordResetTemplate } from "./emailTemplates/passwordReset";
import { signupVerificationTemplate } from "./emailTemplates/signupVerification";

async function main() {
	console.log("[Worker]: Starting.");
	await boss.start();
	await ensureQueues();

	await boss.work<PasswordResetEmailJob>(QUEUE.PASSWORD_RESET_EMAIL, async ([job]) => {
		const emailHtml = loadEmailTemplate(passwordResetTemplate, {
			resetpassword_url: job.data.resetPasswordUrl
		});
		await sendEmail(job.data.email, "Reset your davidnet password", emailHtml);
	});

	await boss.work<SignupVerifyEmailJob>(QUEUE.SIGNUP_VERIFY_EMAIL, async ([job]) => {
		const verifyUrl =
			(Bun.env.NODE_ENV === "production"
				? "https://account.davidnet.net"
				: "http://localhost:5173") +
			"/signup/verify/email/confirm/" +
			job.data.emailVerificationToken;

		const htmlContent = signupVerificationTemplate.replaceAll("{{verifyemail_url}}", verifyUrl);
		await sendEmail(job.data.email, "Davidnet - Email Verification", htmlContent);
	});

	await boss.work<AuditLogEmailJob>(QUEUE.AUDIT_LOG_EMAIL, async ([job]) => {
		// Looked up here, not at enqueue time: if the user was deleted since the audit log row was
		// written, there's nothing to email - no-op rather than retry forever on a dangling userId.
		const userRecord = await database.query.users.findFirst({
			where: eq(users.userId, job.data.userId),
			columns: { email: true }
		});
		if (!userRecord?.email) {
			console.warn(`[Worker]: audit-log-email: no email for user ${job.data.userId}, skipping.`);
			return;
		}

		const htmlContent = auditLogTemplateEmail.replaceAll("{{message}}", job.data.message);
		await sendEmail(userRecord.email, "Davidnet - Audit log", htmlContent);
	});

	await boss.work<VideoDurationProbeJob>(QUEUE.VIDEO_DURATION_PROBE, async ([job]) => {
		const { shortId, bucket, key } = job.data;

		const s3Object = await getFromBucket(bucket, key);
		if (!s3Object.Body) throw new Error(`Object ${bucket}/${key} has no body`);

		const tempFilePath = path.join(os.tmpdir(), key);
		try {
			await fs.writeFile(tempFilePath, await s3Object.Body.transformToByteArray());
			const duration = await getVideoDurationInSeconds(tempFilePath);
			await database
				.update(shorts)
				.set({ videoLength: Math.max(1, Math.round(duration)) })
				.where(eq(shorts.id, shortId));
		} finally {
			await fs.unlink(tempFilePath).catch(() => {});
		}
	});

	console.log("[Worker]: Ready.");
}

const handleShutdown = async (signal: string) => {
	console.log(`[Worker Shutdown]: Received ${signal}.`);
	await boss.stop();
	await closeDbConnection();
	process.exit(0);
};

main().catch((err) => {
	console.error("[Worker]: Failed to start:", err);
	process.exit(1);
});
process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
