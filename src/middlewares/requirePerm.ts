import { createMiddleware } from "hono/factory";
import { hasPermission } from "../core/shared/checkPermissions";

export const requirePerm = (permissionKey: string) => {
	return createMiddleware(async (c, next) => {
		const userID = c.get("user").id;
		const workspaceId = c.req.param("workspaceId");
		const teamId = c.req.param("teamId"); // undefined for workspace-wide routes

		if (!userID || !workspaceId) {
			return c.json(
				{
					sucess: false,
					code: "NO_PERMISSION",
					permisson: permissionKey,
					message: "Missing authentication or workspace context"
				},
				401
			);
		}

		const allowed = await hasPermission({
			userId: userID,
			workspaceId,
			teamId, // passed as undefined if missing in URL
			permissionKey
		});

		if (!allowed) {
			return c.json({ error: "Forbidden: Missing required permission" }, 403);
		}

		await next();
	});
};
