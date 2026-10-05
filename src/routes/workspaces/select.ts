import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { users, workspaces, workspaceUserRoles } from "../../core/database/schema/schema";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const select = new Hono<Env>();

select.put("/", requireAuth, async (c) => {
	// /workspaces/select
	const userID = c.get("user").id;

	const body = await c.req.json<{ workspaceId: string }>();
	const { workspaceId } = body;

	if (!workspaceId) {
		return c.json({ success: false, code: "MISSING_WORKSPACE_ID" }, 400);
	}

	const workspaceResult = await database
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1);

	if (workspaceResult.length === 0) {
		return c.json({ success: false, code: "WORKSPACE_NOT_FOUND" }, 404);
	}

	const workspace = workspaceResult[0];

	// Verify the user has access to this workspace.
	// For personal workspaces, the user must be the owner.
	if (workspace.type === "personal") {
		if (workspace.ownerId !== userID) {
			return c.json({ success: false, code: "FORBIDDEN" }, 403);
		}
	} else {
		// For organization workspaces, the user must hold a role in workspaceUserRoles.
		const [membership] = await database
			.select({ workspaceId: workspaceUserRoles.workspaceId })
			.from(workspaceUserRoles)
			.where(
				and(
					eq(workspaceUserRoles.workspaceId, workspaceId),
					eq(workspaceUserRoles.userId, userID)
				)
			)
			.limit(1);

		if (!membership) {
			return c.json({ success: false, code: "FORBIDDEN" }, 403);
		}
	}

	await database
		.update(users)
		.set({ lastActiveWorkspaceId: workspaceId })
		.where(eq(users.userId, userID));

	return c.json({
		success: true,
		code: "WORKSPACE_SELECTED",
		activeWorkspaceId: workspaceId
	});
});
