import { sValidator } from "@hono/standard-validator";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";

import { database } from "../../core/database/client";
import { signupStatus, users } from "../../core/database/schema/schema";
import { loginSchema } from "../../core/requestSchemas/login";
import { createUserSession } from "../../core/shared/jwt";
import { createRateLimiter } from "../../middlewares/rateLimiter";

export const login = new Hono();

login.post(
	"/",
	createRateLimiter(15, 15 * 60 * 1000),
	sValidator("json", loginSchema),
	async (c) => {
		const data = c.req.valid("json");
		const identifier = data.identifier.trim().toLowerCase();

		// 2. JOIN `signupStatus` AND SELECT ONBOARDING FLAGS
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

		//
		// 2FA
		// ------
		// Just return a 2FAToken
		// It will authenticate the result call from the user 2FA choice.
		// And
		// Authenticate the user to ask for 2FA methods!
		//

		const refreshToken = await createUserSession(user.userId, c);

		setCookie(c, "refresh_token", refreshToken, {
			path: "/",
			secure: process.env.NODE_ENV === "production",
			httpOnly: true,
			maxAge: 30 * 24 * 60 * 60, // 60 Days
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
