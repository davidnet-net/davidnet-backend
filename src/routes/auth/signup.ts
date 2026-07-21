import { sValidator } from "@hono/standard-validator";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { signupStatus, userPreferences, users } from "../../core/database/schema/schema";
import {
	changeSignupEmailSchema,
	initialPreferencesSchema,
	signupSchema,
	verifyEmailSchema
} from "../../core/requestSchemas/signup";
import { createUserAuditLog } from "../../core/shared/auditLogs";
import { sendSignupVerifyEmail } from "../../core/shared/signupVerifyEmail";
import { isInvalidEmail } from "../../core/utils/emails";
import { isValidSignupToken } from "../../core/utils/signupTokenValidator";
import { isValidUuidV4 } from "../../core/utils/uuidvalidator";
import { createRateLimiter } from "../../middlewares/rateLimiter";

export const signup = new Hono();

signup.post(
	"/",
	createRateLimiter(3, 15 * 60 * 1000),
	sValidator("json", signupSchema),
	async (c) => {
		const data = c.req.valid("json");

		// Legal validation
		if (!data.legalAccepted) {
			return c.json({ success: false, code: "LEGAL_NOT_ACCEPTED" }, 400);
		}

		// Username validation
		const username = data.username.trim().toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(username)) {
			return c.json({ success: false, code: "USERNAME_REGEX" }, 400);
		}

		// Email validation
		const email = data.email.trim().toLowerCase();
		const isInvalidEmailResult = await isInvalidEmail(email);
		if (isInvalidEmailResult) {
			return c.json({ success: false, code: isInvalidEmailResult }, 400);
		}

		// Password validation
		if (data.password.length < 8) {
			return c.json({ success: false, code: "PASSWORD_SHORT" }, 400);
		}

		// Existing user
		const existingUser = await database
			.select({
				userID: users.userId,
				email: users.email,
				username: users.username
			})
			.from(users)
			.where(or(eq(users.email, email), eq(users.username, username)))
			.limit(1);

		if (existingUser.length > 0) {
			if (existingUser[0].email === email) {
				return c.json({ success: false, code: "EMAIL_TAKEN" }, 400);
			}
			if (existingUser[0].username === username) {
				return c.json({ success: false, code: "USERNAME_TAKEN" }, 400);
			}
		}

		// HIBP check
		try {
			const sha1Hasher = new Bun.CryptoHasher("sha1");
			sha1Hasher.update(data.password);
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

		// Validation complete
		// - username
		// - password
		// - email

		// Hash the password
		const password = await Bun.password.hash(data.password, {
			algorithm: "argon2id",
			memoryCost: 19456,
			timeCost: 4
		});

		const userInsertion = await database
			.insert(users)
			.values({
				username: username,
				password: password,
				email: email,
				displayName: username
			})
			.returning({ userID: users.userId, email: users.email });

		const signupStatusInsertion = await database
			.insert(signupStatus)
			.values({
				userId: userInsertion[0].userID
			})
			.returning({
				signupToken: signupStatus.signupToken,
				emailVerificationToken: signupStatus.emailVerificationToken
			});

		// Send signup mail
		sendSignupVerifyEmail(signupStatusInsertion[0].emailVerificationToken, userInsertion[0].email);

		await createUserAuditLog(userInsertion[0].userID, "Account created.");

		return c.json(
			{
				success: true,
				code: "USER_CREATED",
				signupToken: signupStatusInsertion[0].signupToken,
				email: userInsertion[0].email
			},
			201
		);
	}
);

signup.patch(
	"/change-email",
	createRateLimiter(6, 15 * 60 * 1000),
	sValidator("json", changeSignupEmailSchema),
	async (c) => {
		const signupToken = c.req.header("X-SignupToken");

		const userId = await isValidSignupToken(signupToken);
		if (!userId) {
			return c.json({ success: false, code: "SIGNUPTOKEN_INVALID" }, 401);
		}

		const data = c.req.valid("json");

		const email = data.email.trim().toLowerCase();
		const isInvalidEmailResult = await isInvalidEmail(email);
		if (isInvalidEmailResult) {
			return c.json({ success: false, code: isInvalidEmailResult }, 400);
		}

		const existingUser = await database
			.select({
				userID: users.userId,
				email: users.email
			})
			.from(users)
			.where(eq(users.email, email))
			.limit(1);

		if (existingUser.length > 0) {
			return c.json({ success: false, code: "EMAIL_TAKEN" }, 400);
		}

		// Validation complete
		// - email valid and not taken
		// - token valid and exists

		const updateResult = await database
			.update(users)
			.set({
				email: email
			})
			.where(eq(users.userId, userId as string))
			.returning({ email: users.email });

		const existingSignupStatus = await database
			.select({
				userID: signupStatus.userId,
				emailVerificationToken: signupStatus.emailVerificationToken
			})
			.from(signupStatus)
			.where(eq(signupStatus.userId, userId as string))
			.limit(1);

		// Send signup mail
		sendSignupVerifyEmail(existingSignupStatus[0].emailVerificationToken, updateResult[0].email);

		return c.json(
			{
				success: true,
				code: "EMAIL_CHANGED",
				email: updateResult[0].email
			},
			200
		);
	}
);

signup.post("/resend-email", createRateLimiter(3, 15 * 60 * 1000), async (c) => {
	const signupToken = c.req.header("X-SignupToken");

	const userId = await isValidSignupToken(signupToken);
	if (!userId) {
		return c.json({ success: false, code: "SIGNUPTOKEN_INVALID" }, 401);
	}

	const existingUser = await database
		.select({
			userID: users.userId,
			email: users.email
		})
		.from(users)
		.where(eq(users.userId, userId as string))
		.limit(1);

	const existingSignupStatus = await database
		.select({
			userID: signupStatus.userId,
			emailVerificationToken: signupStatus.emailVerificationToken
		})
		.from(signupStatus)
		.where(eq(signupStatus.userId, userId as string))
		.limit(1);

	// Send signup mail
	sendSignupVerifyEmail(existingSignupStatus[0].emailVerificationToken, existingUser[0].email);

	return c.json(
		{
			success: true,
			code: "EMAIL_RESEND"
		},
		200
	);
});

signup.post(
	"/verify-email",
	sValidator("json", verifyEmailSchema),
	createRateLimiter(15, 15 * 60 * 1000),
	async (c) => {
		const data = c.req.valid("json");
		const emailVerificationToken = data.emailVerificationToken;

		if (!isValidUuidV4(emailVerificationToken)) {
			return c.json({ success: false, code: "EMAIL_VERIFICATION_TOKEN_INVALID" }, 400);
		}

		const existingSignupStatus = await database
			.select({
				userID: signupStatus.userId,
				emailVerificationToken: signupStatus.emailVerificationToken
			})
			.from(signupStatus)
			.where(eq(signupStatus.emailVerificationToken, emailVerificationToken as string))
			.limit(1);

		if (existingSignupStatus.length === 0) {
			return c.json({ success: false, code: "EMAIL_VERIFICATION_TOKEN_INVALID" }, 400);
		}

		await database
			.update(signupStatus)
			.set({
				emailVerified: true
			})
			.where(eq(signupStatus.emailVerificationToken, emailVerificationToken as string));

		const user = await database
			.select({
				userID: users.userId,
				email: users.email
			})
			.from(users)
			.where(eq(users.userId, existingSignupStatus[0].userID))
			.limit(1);

		await createUserAuditLog(user[0].userID, "Initial email (" + user[0].email + ") verified.");

		return c.json(
			{
				success: true,
				code: "EMAIL_VERIFIED"
			},
			200
		);
	}
);

signup.get("/email-verified", async (c) => {
	const signupToken = c.req.header("X-SignupToken");

	const userId = await isValidSignupToken(signupToken);
	if (!userId) {
		return c.json({ success: false, code: "SIGNUPTOKEN_INVALID" }, 401);
	}

	const [status] = await database
		.select({
			emailVerified: signupStatus.emailVerified
		})
		.from(signupStatus)
		.where(eq(signupStatus.userId, userId as string))
		.limit(1);

	if (!status.emailVerified) {
		return c.json(
			{
				success: true,
				code: "EMAIL_NOT_VERIFIED"
			},
			200
		);
	}

	return c.json(
		{
			success: true,
			code: "EMAIL_VERIFIED"
		},
		200
	);
});

signup.post(
	"/preferences",
	createRateLimiter(5, 15 * 60 * 1000),
	sValidator("json", initialPreferencesSchema),
	async (c) => {
		const signupToken = c.req.header("X-SignupToken");

		// 1. Validate the signup token
		const userId = await isValidSignupToken(signupToken);
		if (!userId) {
			return c.json({ success: false, code: "SIGNUPTOKEN_INVALID" }, 401);
		}

		const data = c.req.valid("json");

		// 2. Insert or Update Preferences (Upsert prevents errors on double-submissions)
		await database
			.insert(userPreferences)
			.values({
				userId: userId as string,
				theme: data.theme as "system" | "dark" | "light" | "contrast",
				language: data.language,
				timezone: data.timezone,
				firstDayOfWeek: data.firstDayOfWeek,
				dateFormat: data.dateFormat
			})
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: {
					theme: data.theme as "system" | "dark" | "light" | "contrast",
					language: data.language,
					timezone: data.timezone,
					firstDayOfWeek: data.firstDayOfWeek,
					dateFormat: data.dateFormat
				}
			});

		// 3. Mark the preferences step as completed in signup_status
		await database
			.update(signupStatus)
			.set({
				preferencesStepCompleted: true
			})
			.where(eq(signupStatus.userId, userId as string));

		// 4. Return success
		return c.json(
			{
				success: true,
				code: "PREFERENCES_SAVED"
			},
			200
		);
	}
);
