import { Hono } from "hono";

import { auth } from "./auth/auth";
import { health } from "./health";
import { oauth } from "./oauth";

export async function registerRoutes(app: Hono) {
	app.route("/health", health);
	app.route("/auth", auth);
	app.route("/oauth", oauth);
	app.get("/.well-known/openid-configuration", (c) => {
		return c.json({
			issuer: "https://davidnet-backend.davidnet.net",
			authorization_endpoint: "https://davidnet-backend.davidnet.net/oauth/authorize",
			token_endpoint: "https://davidnet-backend.davidnet.net/oauth/token",
			userinfo_endpoint: "https://davidnet-backend.davidnet.net/oauth/userinfo",
			jwks_uri: "https://davidnet-backend.davidnet.net/.well-known/jwks.json",
			response_types_supported: ["code"],
			subject_types_supported: ["public"],
			id_token_signing_alg_values_supported: ["RS256"]
		});
	});
}
