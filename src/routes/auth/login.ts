import { sValidator } from "@hono/standard-validator";
import { and, eq, gt, or } from "drizzle-orm";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { verify } from "otplib";

import { database } from "../../core/database/client";
import {
	securityConfig,
	signupStatus,
	twoFactorTokens,
	users
} from "../../core/database/schema/schema";
import {
	loginSchema,
	verify2faSchema,
	verifyRecoveryCodeSchema
} from "../../core/requestSchemas/login";
import { createUserSession } from "../../core/shared/jwt";
import { createRateLimiter } from "../../middlewares/rateLimiter";
import { verifyAndConsumeBackupCode } from "../../core/shared/recoveryCodes";

export const login = new Hono();

login.post(
	"/",
	createRateLimiter(15, 15 * 60 * 1000),
	sValidator("json", loginSchema),
	async (c) => {
		const data = c.req.valid("json");
		const identifier = data.identifier.trim().toLowerCase();

		// 1. JOIN `signupStatus` AND SELECT ONBOARDING FLAGS
		const userResult = await database
			.select({
				userId: users.userId,
				password: users.password,
				email: users.email,
				emailVerified: signupStatus.emailVerified,
				preferencesStepCompleted: signupStatus.preferencesStepCompleted,
				signupToken: signupStatus.signupToken
			})
			.from(users)
			.leftJoin(signupStatus, eq(users.userId, signupStatus.userId))
			.where(or(eq(users.email, identifier), eq(users.username, identifier)))
			.limit(1);

		if (userResult.length === 0) {
			return c.json({ success: false, code: "INVALID_CREDENTIALS" }, 401);
		}

		const user = userResult[0];

		const isPasswordValid = await Bun.password.verify(data.password, user.password);
		if (!isPasswordValid) {
			return c.json({ success: false, code: "INVALID_CREDENTIALS" }, 401);
		}

		if (!user.emailVerified || !user.preferencesStepCompleted) {
			return c.json(
				{
					success: false,
					code: "ONBOARDING_INCOMPLETE",
					details: {
						emailVerified: user.emailVerified || false,
						preferencesStepCompleted: user.preferencesStepCompleted || false,
						signupToken: user.signupToken,
						email: user.email
					}
				},
				403
			);
		}

		// 2. CHECK IF 2FA IS ENABLED
		const securityResult = await database
			.select({
				authenticatorEnabled: securityConfig.authenticatorEnabled
			})
			.from(securityConfig)
			.where(eq(securityConfig.userId, user.userId))
			.limit(1);

		const is2FAEnabled = securityResult[0]?.authenticatorEnabled ?? false;

		if (is2FAEnabled) {
			const mfaToken = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // Valid for 5 minutes

			// Save the challenge token in the database
			await database.insert(twoFactorTokens).values({
				token: mfaToken,
				userId: user.userId,
				expiresAt,
				used: false
			});

			return c.json(
				{
					success: false,
					code: "MFA_REQUIRED",
					mfaToken: mfaToken
				},
				200
			);
		}

		// 3. PROCEED WITH NORMAL LOGIN IF NO 2FA
		const refreshToken = await createUserSession(user.userId, c);

		setCookie(c, "refresh_token", refreshToken, {
			path: "/",
			secure: process.env.NODE_ENV === "production",
			httpOnly: true,
			maxAge: 30 * 24 * 60 * 60, // 30 Days
			sameSite: "Lax"
		});

		return c.json(
			{
				code: "LOGIN_COMPLETE",
				success: true
			},
			200
		);
	}
);

login.post("/verify-2fa", sValidator("json", verify2faSchema), async (c) => {
	const { mfaToken, code } = c.req.valid("json");

	// 1. Validate the database-backed temporary 2FA token
	const tokenRecord = await database
		.select()
		.from(twoFactorTokens)
		.where(
			and(
				eq(twoFactorTokens.token, mfaToken),
				eq(twoFactorTokens.used, false),
				gt(twoFactorTokens.expiresAt, new Date())
			)
		)
		.limit(1);

	if (tokenRecord.length === 0) {
		return c.json({ success: false, code: "INVALID_OR_EXPIRED_MFA_TOKEN" }, 401);
	}

	const { userId } = tokenRecord[0];

	// 2. Mark the token as used immediately to prevent replay attacks
	await database
		.update(twoFactorTokens)
		.set({ used: true })
		.where(eq(twoFactorTokens.token, mfaToken));

	// 3. Fetch user's TOTP configuration seed
	const securityRecord = await database
		.select({
			seed: securityConfig.authenticatorSeed
		})
		.from(securityConfig)
		.where(eq(securityConfig.userId, userId))
		.limit(1);

	if (!securityRecord.length || !securityRecord[0].seed) {
		return c.json({ success: false, code: "MFA_NOT_CONFIGURED" }, 400);
	}

	// 4. Verify the TOTP code against the seed using otplib
	const isValidCode = verify({
		token: code.trim(),
		secret: securityRecord[0].seed
	});

	if (!isValidCode) {
		return c.json({ success: false, code: "INVALID_TOTP_CODE" }, 401);
	}

	// 5. Success: Create final session & set refresh token cookie
	const refreshToken = await createUserSession(userId, c);

	setCookie(c, "refresh_token", refreshToken, {
		path: "/",
		secure: process.env.NODE_ENV === "production",
		httpOnly: true,
		maxAge: 30 * 24 * 60 * 60, // 30 Days
		sameSite: "Lax"
	});

	return c.json(
		{
			success: true,
			code: "LOGIN_COMPLETE"
		},
		200
	);
});

login.post("/verify-recovery-code", sValidator("json", verifyRecoveryCodeSchema), async (c) => {
	const { mfaToken, code } = c.req.valid("json");

	// 1. Validate the database-backed temporary 2FA token
	const tokenRecord = await database
		.select()
		.from(twoFactorTokens)
		.where(
			and(
				eq(twoFactorTokens.token, mfaToken),
				eq(twoFactorTokens.used, false),
				gt(twoFactorTokens.expiresAt, new Date())
			)
		)
		.limit(1);

	if (tokenRecord.length === 0) {
		return c.json({ success: false, code: "INVALID_OR_EXPIRED_MFA_TOKEN" }, 401);
	}

	const { userId } = tokenRecord[0];

	// 2. Mark the challenge token as used immediately to prevent replay attacks
	await database
		.update(twoFactorTokens)
		.set({ used: true })
		.where(eq(twoFactorTokens.token, mfaToken));

	// 3. Verify and consume the backup code against user's stored hashes
	const isRecoveryCodeValid = await verifyAndConsumeBackupCode(userId, code.trim());

	if (!isRecoveryCodeValid) {
		return c.json({ success: false, code: "INVALID_RECOVERY_CODE" }, 401);
	}

	// 4. Success: Create final session & set refresh token cookie
	const refreshToken = await createUserSession(userId, c);

	setCookie(c, "refresh_token", refreshToken, {
		path: "/",
		secure: process.env.NODE_ENV === "production",
		httpOnly: true,
		maxAge: 30 * 24 * 60 * 60, // 30 Days
		sameSite: "Lax"
	});

	return c.json(
		{
			success: true,
			code: "LOGIN_COMPLETE"
		},
		200
	);
});
