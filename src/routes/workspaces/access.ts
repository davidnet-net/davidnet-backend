import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { Env } from "../../middlewares/requireAuth";
import { database } from "../../core/database/client";
import {
	workspaces,
	rolePermissions,
	teams,
	teamUserRoles,
	workspaceUserRoles
} from "../../core/database/schema/schema";

export const access = new Hono<Env>();

access.get("/", async (c) => {
	const userId = c.get("user").id;
	const workspaceId = c.req.param("workspaceId");

	// TypeScript now knows workspaceId is definitely a string
	if (!workspaceId) {
		return c.json({ success: false, code: "MISSING_WORKSPACE_ID" }, 400);
	}

	// 1. Verify workspace and get baseline info
	const workspace = await database.query.workspaces.findFirst({
		where: eq(workspaces.id, workspaceId),
		columns: { ownerId: true, type: true }
	});

	if (!workspace) {
		return c.json({ success: false, code: "WORKSPACE_NOT_FOUND" }, 404);
	}

	const isOwner = workspace.ownerId === userId;
	const isPersonal = workspace.type === "personal";

	// 2. Fetch Workspace-Level Permissions
	// Joins the user's workspace roles with the actual permission keys
	const wsRolesResult = await database
		.select({ key: rolePermissions.permissionKey })
		.from(workspaceUserRoles)
		.innerJoin(rolePermissions, eq(workspaceUserRoles.roleId, rolePermissions.roleId))
		.where(
			and(eq(workspaceUserRoles.workspaceId, workspaceId), eq(workspaceUserRoles.userId, userId))
		);

	const workspacePermissions = wsRolesResult.map((r) => r.key);

	// 3. Fetch Team-Level Permissions (for teams within this workspace)
	// We join the teams table to ensure we only get roles for teams in THIS workspace
	const teamRolesResult = await database
		.select({
			teamId: teamUserRoles.teamId,
			key: rolePermissions.permissionKey
		})
		.from(teamUserRoles)
		.innerJoin(rolePermissions, eq(teamUserRoles.roleId, rolePermissions.roleId))
		.innerJoin(teams, eq(teamUserRoles.teamId, teams.id))
		.where(and(eq(teams.workspaceId, workspaceId), eq(teamUserRoles.userId, userId)));

	// Group the linear SQL result into a Map/Record format (teamId -> string[])
	const teamPermissions: Record<string, string[]> = {};
	for (const row of teamRolesResult) {
		if (!teamPermissions[row.teamId]) {
			teamPermissions[row.teamId] = [];
		}
		teamPermissions[row.teamId].push(row.key);
	}

	return c.json({
		success: true,
		isOwner,
		isPersonal,
		workspacePermissions,
		teamPermissions
	});
});
