import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

export type Env = {
	Variables: {
		user?: {
			id: string;
			jwtID: string;
		};
	};
};

export const collectAuth = createMiddleware<Env>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;

	if (!token) {
		c.set("user", undefined);
		return await next();
	}

	const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
	if (!ACCESS_SECRET) {
		throw new Error("JWT_ACCESS_SECRET is not configured");
	}

	try {
		const payload = await verify(token, ACCESS_SECRET, "HS256");

		if (payload.type && payload.type !== "access") {
			c.set("user", undefined);
			return await next();
		}

		const userID = payload.userID as string;
		const jwtID = payload.jwtID as string;

		if (!userID) {
			c.set("user", undefined);
			return await next();
		}

		c.set("user", {
			id: userID,
			jwtID
		});
	} catch {
		c.set("user", undefined);
	}

	await next();
});
