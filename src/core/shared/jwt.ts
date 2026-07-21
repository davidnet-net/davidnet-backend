import { sign } from "hono/jwt";

import { database } from "../database/client";
import { sessionTokens } from "../database/schema/schema";

const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

export async function createUserSession(userID: string) {
	const now = new Date();
	const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

	const [insertedToken] = await database
		.insert(sessionTokens)
		.values({
			userId: userID,
			issuedAt: now,
			expiresAt: expires
		})
		.returning({ jwtId: sessionTokens.jwtId });

	const refreshTokenPayload = {
		userID: userID,
		jwtID: insertedToken.jwtId,
		issuedAt: Math.floor(now.getTime() / 1000),
		expiresAt: Math.floor(expires.getTime() / 1000)
	};

	if (!REFRESH_SECRET) {
		throw new Error("[JWT]: JWT_REFRESH_SECRET is not defined in environment variables!");
	}
	const refreshToken = await sign(refreshTokenPayload, REFRESH_SECRET);
	return refreshToken;
}
