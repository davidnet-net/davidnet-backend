import { Hono } from "hono";

import { auth } from "./auth/auth";
import { health } from "./health";
import { oidc } from "./oidc";
import { exportJWK, importPKCS8 } from "jose";

export async function registerRoutes(app: Hono) {
	app.route("/health", health);
	app.route("/auth", auth);
	app.route("/oidc", oidc);

	app.get("/.well-known/openid-configuration", (c) => {
		const issuer = "https://davidnet-backend.davidnet.net";
		return c.json({
			issuer: issuer,
			authorization_endpoint: `${issuer}/oidc/authorize`,
			token_endpoint: `${issuer}/oidc/token`,
			userinfo_endpoint: `${issuer}/oidc/userinfo`,
			jwks_uri: `${issuer}/.well-known/jwks.json`,
			response_types_supported: ["code"],
			subject_types_supported: ["public"],
			id_token_signing_alg_values_supported: ["RS256"],
			scopes_supported: ["openid", "profile", "email"]
		});
	});
	app.get("/.well-known/jwks.json", async (c) => {
		const rawPrivateKey = process.env.OIDC_PRIVATE_KEY;
		if (!rawPrivateKey) {
			return c.json({ error: "Server configuration error" }, 500);
		}

		try {
			const privateKeyPem = rawPrivateKey.replace(/\\n/g, "\n");
			const privateKey = await importPKCS8(privateKeyPem, "RS256");

			// Export public components as a JWK
			const publicJwk = await exportJWK(privateKey);

			// Strip private key fields to ensure only the public key is served
			delete publicJwk.d;
			delete publicJwk.p;
			delete publicJwk.q;
			delete publicJwk.dp;
			delete publicJwk.dq;
			delete publicJwk.qi;

			publicJwk.alg = "RS256";
			publicJwk.use = "sig";
			publicJwk.kid = "internal-oidc-key-1";

			return c.json({
				keys: [publicJwk]
			});
		} catch {
			return c.json({ error: "Failed to generate JWKS" }, 500);
		}
	});
}
