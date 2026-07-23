import { Env, Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import {
	authenticatorEnableSchema,
	changePasswordSchema,
	logoutSessionSchema
} from "../../core/requestSchemas/security";
import { requireAuth } from "../../middlewares/requireAuth";
import { createUserAuditLog } from "../../core/shared/auditLogs";
import { database } from "../../core/database/client";
import { eq, and, ne } from "drizzle-orm";
import { users, sessionTokens, securityConfig } from "../../core/database/schema/auth";

export const security = new Hono<Env>();

security.post(
	"/change-password",
	requireAuth,
	sValidator("json", changePasswordSchema),
	async (c) => {
		const userID = c.get("user").id;
		const jwtID = c.get("user").jwtID;
		const data = c.req.valid("json");

		// Password validation
		if (data.newPassword.length < 8) {
			return c.json({ success: false, code: "PASSWORD_SHORT" }, 400);
		}

		// HIBP check
		try {
			const sha1Hasher = new Bun.CryptoHasher("sha1");
			sha1Hasher.update(data.newPassword);
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
			// FAIL SIlENT: So that we dont need the HIBP for the signup
			console.warn("[auth]: HIBP ERROR", e);
		}

		const userResult = await database
			.select({
				userId: users.userId,
				password: users.password
			})
			.from(users)
			.where(eq(users.userId, userID))
			.limit(1);

		// Ensure the user actually exists in the database
		if (!userResult.length) {
			return c.json({ success: false, code: "USER_NOT_FOUND" }, 404);
		}

		const isPasswordValid = await Bun.password.verify(data.oldPassword, userResult[0].password);
		if (!isPasswordValid) {
			return c.json({ success: false, code: "INVALID_CREDENTIALS" }, 401);
		}

		const isPasswordSame = await Bun.password.verify(data.newPassword, userResult[0].password);
		if (isPasswordSame) {
			return c.json({ success: false, code: "SAME_PASSWORD" }, 400);
		}

		// Hash the password
		const newPasswordHashed = await Bun.password.hash(data.newPassword, {
			algorithm: "argon2id",
			memoryCost: 19456,
			timeCost: 4
		});

		// Update the user's password in the database
		await database
			.update(users)
			.set({ password: newPasswordHashed })
			.where(eq(users.userId, userID));

		// Delete all other sessions for this user, keeping the current one alive
		await database
			.delete(sessionTokens)
			.where(and(eq(sessionTokens.userId, userID), ne(sessionTokens.jwtId, jwtID)));

		await createUserAuditLog(userID, "Password changed and other sessions revoked.");

		return c.json(
			{
				success: true,
				code: "PASSWORD_CHANGED"
			},
			200
		);
	}
);

security.get("/sessions", requireAuth, async (c) => {
	const userID = c.get("user").id;

	const sessionsResult = await database
		.select({
			jwtId: sessionTokens.jwtId,
			issuedAt: sessionTokens.issuedAt,
			expiresAt: sessionTokens.expiresAt,
			ip: sessionTokens.ip,
			countryCode: sessionTokens.countryCode,
			userAgent: sessionTokens.userAgent
		})
		.from(sessionTokens)
		.where(eq(sessionTokens.userId, userID));

	return c.json(
		{
			success: true,
			code: "SESSIONS",
			sessions: sessionsResult
		},
		200
	);
});

security.delete("/session", requireAuth, sValidator("json", logoutSessionSchema), async (c) => {
	const userID = c.get("user").id;
	const jwtID = c.get("user").jwtID;
	const data = c.req.valid("json");

	if (jwtID === data.jwtID) {
		return c.json({ success: false, code: "USE_NORMAL_LOGOUT" }, 400);
	}
	await database
		.delete(sessionTokens)
		.where(and(eq(sessionTokens.jwtId, data.jwtID), eq(sessionTokens.userId, userID)));

	return c.json({ success: true, code: "LOGGED_OUT" }, 200);
});

security.delete("/sessions", requireAuth, async (c) => {
	const userID = c.get("user").id;
	const jwtID = c.get("user").jwtID;

	await database
		.delete(sessionTokens)
		.where(and(ne(sessionTokens.jwtId, jwtID), eq(sessionTokens.userId, userID)));

	return c.json({ success: true, code: "LOGGED_OUT" }, 200);
});

import { generateSecret, generateURI, verify } from "otplib";

security.get("/authenticater-setup", requireAuth, async (c) => {
	const userID = c.get("user").id;

	// Query 1: Fetch user email
	const [user] = await database
		.select({
			userId: users.userId,
			email: users.email
		})
		.from(users)
		.where(eq(users.userId, userID))
		.limit(1);

	if (!user) {
		return c.json({ success: false, code: "USER_NOT_FOUND" }, 404);
	}

	// Query 2: Check current security settings
	const [userSecurity] = await database
		.select({
			authenticatorEnabled: securityConfig.authenticatorEnabled
		})
		.from(securityConfig)
		.where(eq(securityConfig.userId, userID))
		.limit(1);

	// Block setup if a row exists AND authenticator is already enabled
	if (userSecurity?.authenticatorEnabled) {
		return c.json(
			{
				success: false,
				code: "AUTHENTICATOR_ALREADY_ENABLED",
				message: "2FA is already enabled for this account."
			},
			400
		);
	}

	// Generate secret & URI
	const secret = generateSecret();

	const otpUri = generateURI({
		issuer: "Davidnet",
		label: user.email,
		secret
	});

	// Save temporary secret to DB
	await database
		.insert(securityConfig)
		.values({
			userId: user.userId,
			authenticatorEnabled: false,
			authenticatorSeed: secret
		})
		.onConflictDoUpdate({
			target: securityConfig.userId,
			set: { authenticatorSeed: secret, authenticatorEnabled: false }
		});

	return c.json({ success: true, code: "SETUP_AUTHENTICATER", otpUri }, 200);
});

security.post(
	"/authenticator-enable",
	requireAuth,
	sValidator("json", authenticatorEnableSchema),
	async (c) => {
		const userID = c.get("user").id;

		const code = c.req.valid("json").code;
		if (code.trim().length !== 6) {
			return c.json(
				{
					success: false,
					code: "INVALID_INPUT",
					message: "A 6-digit code is required."
				},
				400
			);
		}

		// 2. Fetch current security configuration
		const [userSecurity] = await database
			.select({
				authenticatorEnabled: securityConfig.authenticatorEnabled,
				authenticatorSeed: securityConfig.authenticatorSeed
			})
			.from(securityConfig)
			.where(eq(securityConfig.userId, userID))
			.limit(1);

		// 3. Check if setup was initiated
		if (!userSecurity || !userSecurity.authenticatorSeed) {
			return c.json(
				{
					success: false,
					code: "SETUP_NOT_INITIATED",
					message: "Authenticator setup has not been initiated."
				},
				400
			);
		}

		// 4. Check if already enabled
		if (userSecurity.authenticatorEnabled) {
			return c.json(
				{
					success: false,
					code: "AUTHENTICATOR_ALREADY_ENABLED",
					message: "2FA is already enabled for this account."
				},
				400
			);
		}

		// 5. Verify token against stored seed
		const result = await verify({
			secret: userSecurity.authenticatorSeed,
			token: code.trim()
		});

		if (!result.valid) {
			return c.json(
				{
					success: false,
					code: "INVALID_CODE",
					message: "The code provided is invalid or expired."
				},
				400
			);
		}

		// 6. Mark authenticator as enabled
		await database
			.update(securityConfig)
			.set({ authenticatorEnabled: true })
			.where(eq(securityConfig.userId, userID));

		return c.json(
			{
				success: true,
				code: "AUTHENTICATOR_ENABLED",
				message: "2FA authenticator has been successfully enabled."
			},
			200
		);
	}
);

security.get("/2fa-status", requireAuth, async (c) => {
	const userID = c.get("user").id;

	// Fetch current security configuration
	const [userSecurity] = await database
		.select({
			authenticatorEnabled: securityConfig.authenticatorEnabled
		})
		.from(securityConfig)
		.where(eq(securityConfig.userId, userID))
		.limit(1);

	return c.json(
		{
			success: true,
			code: "2FA_STATUS",
			authenticatorEnabled: userSecurity?.authenticatorEnabled ?? false
		},
		200
	);
});

security.put("/disable-authenticator", requireAuth, async (c) => {
	const userID = c.get("user").id;

	// 1. Fetch current security configuration
	const [userSecurity] = await database
		.select({
			authenticatorEnabled: securityConfig.authenticatorEnabled
		})
		.from(securityConfig)
		.where(eq(securityConfig.userId, userID))
		.limit(1);

	// 2. Check if 2FA is actually enabled
	if (!userSecurity || !userSecurity.authenticatorEnabled) {
		return c.json(
			{
				success: false,
				code: "AUTHENTICATOR_NOT_ENABLED",
				message: "2FA is not currently enabled for this account."
			},
			400
		);
	}

	// 3. Disable authenticator and clear seed
	await database
		.update(securityConfig)
		.set({
			authenticatorEnabled: false,
			authenticatorSeed: null
		})
		.where(eq(securityConfig.userId, userID));

	return c.json(
		{
			success: true,
			code: "AUTHENTICATOR_DISABLED",
			message: "Authenticator 2FA has been successfully disabled."
		},
		200
	);
});
