import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import { SignJWT, importPKCS8 } from "jose";

import { database } from "../core/database/client";
import {
	internalAccessTokens,
	authCodes,
	internalAccess,
	sessionTokens,
	users
} from "../core/database/schema/schema";
import type { Env } from "../middlewares/requireAuth";

export const oauth = new Hono<Env>();

const clientRequirements: Record<string, (access: typeof internalAccess.$inferSelect) => boolean> =
	{
		headscale: (access) => access.vpnAccess
	};

oauth.get("/authorize", async (c) => {
	const clientId = c.req.query("client_id");
	const redirectUri = c.req.query("redirect_uri");
	const responseType = c.req.query("response_type");
	const state = c.req.query("state");
	const codeChallenge = c.req.query("code_challenge");

	if (responseType !== "code") {
		return c.json({ success: false, error: "unsupported_response_type" }, 400);
	}
	if (!redirectUri) {
		return c.json(
			{ success: false, error: "invalid_request", message: "Missing redirect_uri" },
			400
		);
	}

	if (!clientId || !clientRequirements[clientId]) {
		return c.json(
			{ success: false, error: "unauthorized_client", message: `Unknown client_id: ${clientId}` },
			400
		);
	}

	// 1. Get the refresh_token from the cookie
	const token = getCookie(c, "refresh_token");
	const returnTo = encodeURIComponent(c.req.url);

	if (!token) {
		return c.redirect(`https://account.davidnet.net/login?continue=${returnTo}`);
	}

	const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
	if (!REFRESH_SECRET) {
		return c.json(
			{ success: false, error: "server_error", message: "JWT_REFRESH_SECRET is not configured" },
			500
		);
	}

	let userID: string;
	let jwtID: string;

	// 2. Verify the refresh token JWT signature & payload type
	try {
		const payload = await verify(token, REFRESH_SECRET, "HS256");

		if (payload.type && payload.type !== "refresh") {
			return c.redirect(`https://account.davidnet.net/login?continue=${returnTo}`);
		}

		userID = payload.userID as string;
		jwtID = payload.jwtID as string;

		if (!userID || !jwtID) {
			return c.redirect(`https://account.davidnet.net/login?continue=${returnTo}`);
		}
	} catch {
		return c.redirect(`https://account.davidnet.net/login?continue=${returnTo}`);
	}

	// 3. Verify session in DB (handles instant logouts and revocations)
	const sessionResult = await database
		.select()
		.from(sessionTokens)
		.where(and(eq(sessionTokens.jwtId, jwtID), gt(sessionTokens.expiresAt, new Date())))
		.limit(1);

	if (sessionResult.length === 0) {
		return c.redirect(`https://account.davidnet.net/login?continue=${returnTo}`);
	}

	// 4. Query DB for Access Permissions
	const internalAccessResult = await database
		.select()
		.from(internalAccess)
		.where(eq(internalAccess.userId, userID))
		.limit(1);

	if (internalAccessResult.length === 0) {
		return c.json({ success: false, code: "ACCESS_RECORD_NOT_FOUND" }, 404);
	}

	const access = internalAccessResult[0];

	if (!access.internalAccess) {
		return c.redirect(`https://account.davidnet.net/internal/access_denied`);
	}

	const hasRequiredAppPermission = clientRequirements[clientId](access);

	if (!hasRequiredAppPermission) {
		return c.redirect(`https://account.davidnet.net/internal/access_denied`);
	}

	// 7. Generate Code & Save to DB
	const code = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
	const expiresAt = new Date(Date.now() + 60 * 1000);

	await database.insert(authCodes).values({
		code,
		userId: userID,
		redirectUri,
		codeChallenge: codeChallenge ?? "",
		expiresAt
	});

	// 8. Redirect back to the Client Application
	const redirectUrl = new URL(redirectUri);
	redirectUrl.searchParams.set("code", code);
	if (state) {
		redirectUrl.searchParams.set("state", state);
	}

	return c.redirect(redirectUrl.toString());
});

// Helper function to verify PKCE code_verifier against the database code_challenge
async function verifyPKCE(codeVerifier: string, codeChallenge: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(codeVerifier);
	const hash = await crypto.subtle.digest("SHA-256", data);

	const base64Url = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return base64Url === codeChallenge;
}

oauth.post("/token", async (c) => {
	const body = await c.req.parseBody();

	const grantType = body.grant_type;
	const code = body.code as string;
	const redirectUri = body.redirect_uri as string;
	const clientId = body.client_id as string;
	const codeVerifier = body.code_verifier as string;

	if (grantType !== "authorization_code") {
		return c.json({ error: "unsupported_grant_type" }, 400);
	}

	// 2. Look up the authorization code in the database
	const authCodeRecord = await database
		.select()
		.from(authCodes)
		.where(eq(authCodes.code, code))
		.limit(1);

	if (authCodeRecord.length === 0) {
		return c.json(
			{ error: "invalid_grant", error_description: "Invalid or already used code" },
			400
		);
	}

	const savedCode = authCodeRecord[0];

	// 3. Validate Expiration and Redirect URI
	if (savedCode.expiresAt < new Date()) {
		await database.delete(authCodes).where(eq(authCodes.code, code));
		return c.json({ error: "invalid_grant", error_description: "Code expired" }, 400);
	}

	if (savedCode.redirectUri !== redirectUri) {
		return c.json({ error: "invalid_grant", error_description: "Redirect URI mismatch" }, 400);
	}

	// 4. Verify PKCE
	if (savedCode.codeChallenge && savedCode.codeChallenge !== "NO_CHALLENGE") {
		if (!codeVerifier) {
			return c.json({ error: "invalid_grant", error_description: "Missing code_verifier" }, 400);
		}
		const isValid = await verifyPKCE(codeVerifier, savedCode.codeChallenge);
		if (!isValid) {
			return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
		}
	}

	// 5. BURN THE CODE IMMEDIATELY
	await database.delete(authCodes).where(eq(authCodes.code, code));

	// 6. Fetch user profile information
	const userResult = await database
		.select()
		.from(users)
		.where(eq(users.userId, savedCode.userId))
		.limit(1);

	if (userResult.length === 0) {
		return c.json({ error: "invalid_grant", error_description: "User not found" }, 400);
	}
	const user = userResult[0];

	// 7. Load Private Key from Environment Variables
	const rawPrivateKey = process.env.OIDC_PRIVATE_KEY;
	if (!rawPrivateKey) {
		return c.json(
			{ error: "server_error", error_description: "OIDC Private Key not configured" },
			500
		);
	}
	const privateKeyPem = rawPrivateKey.replace(/\\n/g, "\n");
	const privateKey = await importPKCS8(privateKeyPem, "RS256");

	// 8. Mint the ID Token (JWT)
	const idToken = await new SignJWT({
		preferred_username: user.username,
		email: user.email,
		name: user.displayName
	})
		.setProtectedHeader({ alg: "RS256", kid: "internal-oidc-key-1" })
		.setIssuedAt()
		.setIssuer("https://davidnet-backend.davidnet.net")
		.setSubject(user.userId)
		.setAudience(clientId)
		.setExpirationTime("1h")
		.sign(privateKey);

	// 9. Generate and Save an Access Token to the DB
	const accessToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
	const tokenExpiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour expiration

	await database.insert(internalAccessTokens).values({
		token: accessToken,
		userId: user.userId,
		expiresAt: tokenExpiresAt
	});

	// 10. Return the token payload back to the client
	return c.json({
		access_token: accessToken,
		token_type: "Bearer",
		expires_in: 3600,
		id_token: idToken
	});
});

// --- USERINFO ENDPOINT ---
oauth.get("/userinfo", async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json(
			{ error: "invalid_token", error_description: "Missing or malformed Authorization header" },
			401
		);
	}

	const token = authHeader.replace("Bearer ", "").trim();

	// Look up active access token in the database using internalAccessTokens
	const tokenRecord = await database
		.select()
		.from(internalAccessTokens)
		.where(
			and(eq(internalAccessTokens.token, token), gt(internalAccessTokens.expiresAt, new Date()))
		)
		.limit(1);

	if (tokenRecord.length === 0) {
		return c.json(
			{ error: "invalid_token", error_description: "Access token is invalid or expired" },
			401
		);
	}

	// Fetch user profile data
	const userResult = await database
		.select()
		.from(users)
		.where(eq(users.userId, tokenRecord[0].userId))
		.limit(1);

	if (userResult.length === 0) {
		return c.json({ error: "invalid_token", error_description: "User no longer exists" }, 401);
	}

	const user = userResult[0];

	// Standard OpenID Connect UserInfo JSON response
	return c.json({
		sub: user.userId,
		preferred_username: user.username,
		email: user.email,
		name: user.displayName,
		email_verified: true
	});
});
