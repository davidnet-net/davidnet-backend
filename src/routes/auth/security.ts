import { Env, Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { changePasswordSchema, logoutSessionSchema } from "../../core/requestSchemas/security";
import { requireAuth } from "../../middlewares/requireAuth";
import { createUserAuditLog } from "../../core/shared/auditLogs";
import { database } from "../../core/database/client";
import { eq, and, ne } from "drizzle-orm";
import { users, sessionTokens } from "../../core/database/schema/auth";

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
