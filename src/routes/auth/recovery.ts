import { eq, and, gt } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { users, passwordResetTokens, auditLogs } from "../../core/database/schema/schema";
import { type Env } from "../../middlewares/requireAuth";
import { createRateLimiter } from "../../middlewares/rateLimiter";
import { sValidator } from "@hono/standard-validator";
import { isInvalidEmail, sendEmail, loadEmailTemplate } from "../../core/utils/emails";
import { sendRecoveryEmailSchema, resetPasswordSchema } from "../../core/requestSchemas/recovery";
import { passwordResetTemplate } from "../../emailTemplates/passwordReset";

export const recovery = new Hono<Env>();

// 1. Request Password Reset Email
recovery.post(
	"/send-recovery-email",
	createRateLimiter(3, 15 * 60 * 1000), // 3 requests per 15 minutes
	sValidator("json", sendRecoveryEmailSchema),
	async (c) => {
		const data = c.req.valid("json");
		const email = data.email.trim().toLowerCase();

		const isInvalidEmailResult = await isInvalidEmail(email);
		if (isInvalidEmailResult) {
			return c.json({ success: false, code: isInvalidEmailResult }, 400);
		}

		const userResult = await database.select().from(users).where(eq(users.email, email)).limit(1);

		if (userResult.length === 0) {
			return c.json({ success: true, code: "MAYBE_SENDED" }, 200);
		}

		const user = userResult[0];
		const token = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // Expires in 1 hour

		// Invalidate previous unused reset tokens for this user
		await database
			.update(passwordResetTokens)
			.set({ used: true })
			.where(eq(passwordResetTokens.userId, user.userId));

		// Insert new reset token
		await database.insert(passwordResetTokens).values({
			token,
			userId: user.userId,
			expiresAt,
			used: false
		});

		const frontendUrl = "https://account.davidnet.net";
		const resetPasswordUrl = `${frontendUrl}/recovery/password/link/${token}`;

		const emailHtml = loadEmailTemplate(passwordResetTemplate, {
			resetpassword_url: resetPasswordUrl
		});

		await sendEmail(user.email, "Reset your davidnet password", emailHtml);

		return c.json({ success: true, code: "MAYBE_SENDED" }, 200);
	}
);

// 2. Confirm & Reset Password Using Token
recovery.post(
	"/reset-password",
	createRateLimiter(5, 15 * 60 * 1000),
	sValidator("json", resetPasswordSchema),
	async (c) => {
		const { token, newPassword } = c.req.valid("json");

		if (newPassword.length < 8) {
			return c.json({ success: false, code: "PASSWORD_SHORT" }, 400);
		}

		// 1. ATOMIC CONSUMPTION: Find the valid token AND immediately mark it as used
		// inside a transaction or atomic update to prevent race conditions.
		const tokenResult = await database.transaction(async (tx) => {
			const found = await tx
				.select()
				.from(passwordResetTokens)
				.where(
					and(
						eq(passwordResetTokens.token, token),
						eq(passwordResetTokens.used, false),
						gt(passwordResetTokens.expiresAt, new Date())
					)
				)
				.limit(1);

			if (found.length === 0) {
				return null;
			}

			// Immediately lock/mark it used so parallel requests fail instantly
			await tx
				.update(passwordResetTokens)
				.set({ used: true })
				.where(eq(passwordResetTokens.token, token));

			return found[0];
		});

		if (!tokenResult) {
			return c.json({ success: false, code: "INVALID_OR_EXPIRED_TOKEN" }, 400);
		}

		const resetRecord = tokenResult;

		// 2. Fetch the user to check if the new password matches their current one
		const userResult = await database
			.select()
			.from(users)
			.where(eq(users.userId, resetRecord.userId))
			.limit(1);

		if (userResult.length === 0) {
			return c.json({ success: false, code: "INVALID_OR_EXPIRED_TOKEN" }, 400);
		}

		const targetUser = userResult[0];

		// Verify if the new password is the same as the existing password
		const isSamePassword = await Bun.password.verify(newPassword, targetUser.password);
		if (isSamePassword) {
			return c.json({ success: false, code: "PASSWORD_SAME_AS_OLD" }, 400);
		}

		// 3. External checks (HIBP) happen safely *after* token consumption and same-password verification.
		try {
			const sha1Hasher = new Bun.CryptoHasher("sha1");
			sha1Hasher.update(newPassword);
			const fullHash = sha1Hasher.digest("hex").toUpperCase();

			const prefix = fullHash.substring(0, 5);
			const suffix = fullHash.substring(5);

			const hibpResponse = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
			if (hibpResponse.ok) {
				const text = await hibpResponse.text();
				const isPwned = text.split("\n").some((line) => {
					const [hashSuffix, count] = line.split(":");
					return hashSuffix === suffix && parseInt(count) > 0;
				});
				if (isPwned) {
					return c.json({ success: false, code: "PASSWORD_PWNED" }, 400);
				}
			}
		} catch (e) {
			console.warn("[auth]: HIBP ERROR", e);
		}

		// 4. Hash the new password using Argon2id
		const hashedPassword = await Bun.password.hash(newPassword, {
			algorithm: "argon2id",
			memoryCost: 19456,
			timeCost: 4
		});

		// 5. Finalize user password update and audit logging
		await database.transaction(async (tx) => {
			await tx
				.update(users)
				.set({
					password: hashedPassword,
					updatedAt: new Date()
				})
				.where(eq(users.userId, resetRecord.userId));

			await tx.insert(auditLogs).values({
				userId: resetRecord.userId,
				message: "Password was reset successfully via recovery token."
			});
		});

		return c.json({ success: true, code: "PASSWORD_RESET_SUCCESS" }, 200);
	}
);
