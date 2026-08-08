import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { internalAccess, users } from "../../core/database/schema/schema";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const internal = new Hono<Env>();

internal.get("/", requireAuth, async (c) => {
	const userID = c.get("user").id;

	const internalAccessResult = await database
		.select()
		.from(internalAccess)
		.where(eq(internalAccess.userId, userID))
		.limit(1);

	if (internalAccessResult.length === 0) {
		return c.json({ success: false, code: "USER_NOT_FOUND" }, 404);
	}

	return c.json({
		success: true,
		code: "SUCCESS",
		access: internalAccessResult[0]
	});
});
