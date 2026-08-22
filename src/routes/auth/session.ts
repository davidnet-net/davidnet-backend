import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";

import { database } from "../../core/database/client";
import { sessionTokens } from "../../core/database/schema/schema";

export const session = new Hono();

session.post("/refresh", async (c) => {
	const refreshToken = getCookie(c, "refresh_token");
	if (!refreshToken) {
		return c.json({ success: false, code: "MISSING_TOKEN" }, 401);
	}

	const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
	if (!REFRESH_SECRET) {
		throw new Error("[JWT]: JWT_REFRESH_SECRET is not defined in environment variables!");
	}

	let payload;
	try {
		payload = await verify(refreshToken, REFRESH_SECRET, "HS256");
	} catch {
		return c.json({ success: false, code: "INVALID_TOKEN" }, 401);
	}

	const jwtID = payload.jwtID as string;
	const userID = payload.userID as string;

	if (!jwtID || !userID) {
		return c.json({ success: false, code: "INVALID_TOKEN_PAYLOAD" }, 401);
	}

	// Check if the refresh token is revoked/deleted in the database
	const sessionResult = await database
		.select()
		.from(sessionTokens)
		.where(eq(sessionTokens.jwtId, jwtID))
		.limit(1);

	if (sessionResult.length === 0) {
		return c.json({ success: false, code: "REVOKED_TOKEN" }, 401);
	}

	const dbSession = sessionResult[0];
	const now = new Date();

	// Check if the refresh token has expired
	if (now > dbSession.expiresAt) {
		return c.json({ success: false, code: "EXPIRED_TOKEN" }, 401);
	}

	// Generate a new access token
	const nowSec = Math.floor(now.getTime() / 1000);
	const expiresSec = nowSec + 15 * 60; // Minimal access token expiration (15 minutes)

	const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || REFRESH_SECRET;

	const accessTokenPayload = {
		userID,
		jwtID,
		type: "access",
		issuedAt: nowSec,
		expiresAt: expiresSec
	};

	const accessToken = await sign(accessTokenPayload, ACCESS_SECRET, "HS256");

	// Set the access token as an HttpOnly cookie
	setCookie(c, "access_token", accessToken, {
		path: "/",
		secure: process.env.NODE_ENV === "production",
		httpOnly: true,
		sameSite: "Lax",
		maxAge: 15 * 60 // 15 minutes (in seconds)
	});

	return c.json({
		accessToken,
		userID,
		jwtID,
		issuedAt: nowSec,
		expiresAt: expiresSec
	});
});

session.delete("/", async (c) => {
	const refreshToken = getCookie(c, "refresh_token");

	const cookieOptions = {
		path: "/",
		secure: process.env.NODE_ENV === "production",
		httpOnly: true,
		sameSite: "Lax" as const // Required to satisfy TypeScript for union types
	};

	// Clear both the refresh and access cookies
	deleteCookie(c, "refresh_token", cookieOptions);
	deleteCookie(c, "access_token", cookieOptions);

	if (!refreshToken) {
		return c.json({ success: true, code: "LOGGED_OUT" }, 200);
	}

	const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
	if (!REFRESH_SECRET) {
		throw new Error("[JWT]: JWT_REFRESH_SECRET is not defined in environment variables!");
	}

	try {
		const payload = await verify(refreshToken, REFRESH_SECRET, "HS256");
		const jwtID = payload.jwtID as string;

		if (jwtID) {
			await database.delete(sessionTokens).where(eq(sessionTokens.jwtId, jwtID));
		}
	} catch {
		// Token was invalid/expired, but cookie is cleared, so we return success
	}

	return c.json({ success: true, code: "LOGGED_OUT" }, 200);
});
