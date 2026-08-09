import { sign } from "hono/jwt";

import { database } from "../database/client";
import { sessionTokens } from "../database/schema/schema";
import { Context } from "hono";
import { type Env } from "../../middlewares/metadata";
import { createUserAuditLog } from "./auditLogs";
import { parseUA } from "../utils/uaParser";

const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

export async function createUserSession(userID: string, c: Context<Env>) {
	const now = new Date();
	const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

	const [insertedToken] = await database
		.insert(sessionTokens)
		.values({
			userId: userID,
			issuedAt: now,
			expiresAt: expires,
			ip: c.get("metadata").ip,
			userAgent: c.get("metadata").userAgent,
			countryCode: c.get("metadata").countryCode
		})
		.returning({ jwtId: sessionTokens.jwtId });

	const parsedUA = parseUA(c.get("metadata").userAgent);
	await createUserAuditLog(
		userID,
		`New login from ${c.get("metadata").countryCode} & ${c.get("metadata").ip}. With: ${parsedUA.device} - ${parsedUA.os} - ${parsedUA.browser}.  .`
	);

	const refreshTokenPayload = {
		userID: userID,
		type: "refresh",
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
