import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

export type Env = {
	Variables: {
		user: {
			id: string;
			jwtID: string;
		};
	};
};

export const requireAuth = createMiddleware<Env>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;

	if (!token) {
		return c.json({ success: false, code: "UNAUTHORIZED" }, 401);
	}

	const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
	if (!ACCESS_SECRET) {
		throw new Error("JWT_ACCESS_SECRET is not configured");
	}

	try {
		const payload = await verify(token, ACCESS_SECRET, "HS256");

		if (payload.type && payload.type !== "access") {
			return c.json({ success: false, code: "INVALID_TOKEN_TYPE" }, 401);
		}

		const userID = payload.userID as string;
		const jwtID = payload.jwtID as string;

		if (!userID) {
			return c.json({ success: false, code: "INVALID_TOKEN_PAYLOAD" }, 401);
		}
		c.set("user", {
			id: userID,
			jwtID
		});

		await next();
	} catch {
		return c.json({ success: false, code: "INVALID_TOKEN" }, 401);
	}
});
