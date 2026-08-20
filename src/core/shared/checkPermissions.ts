import { database } from "../database/client";
import { eq, and, inArray } from "drizzle-orm";
import {
	rolePermissions,
	teamUserRoles,
	workspaces,
	workspaceUserRoles
} from "../database/schema/workspaces";

interface CheckPermParams {
	userId: string;
	workspaceId: string;
	teamId?: string;
	permissionKey: string;
}

/**
 * Checks whether a user possesses a specific permission key within a workspace or team context.
 *
 * Permission evaluation follows a hierarchy:
 * 1. Personal Workspaces & Workspace Owners automatically bypass permission checks and return `true`.
 * 2. Personal Workspaces do not support multi-user RBAC; returns `false` for non-owners.
 * 3. Evaluates Organization-level custom roles assigned to the user.
 * 4. Evaluates Team-level custom roles assigned to the user (if `teamId` is provided).
 *
 * @param params - The parameters for permission checking.
 * @param params.userId - The unique identifier of the user requesting access.
 * @param params.workspaceId - The unique identifier of the workspace (organization or personal).
 * @param params.teamId - (Optional) The unique identifier of the team context, if checking a team-scoped operation.
 * @param params.permissionKey - The target permission string to verify (e.g., `"kanban:create-board"`).
 *
 * @returns A promise that resolves to `true` if the user has the required permission, otherwise `false`.
 *
 * @example
 * ```ts
 * const canCreateBoard = await hasPermission({
 *   userId: "usr_123",
 *   workspaceId: "ws_456",
 *   teamId: "team_789",
 *   permissionKey: "kanban:create-board"
 * });
 * ```
 */
export async function hasPermission({
	userId,
	workspaceId,
	teamId,
	permissionKey
}: CheckPermParams): Promise<boolean> {
	const workspace = await database.query.workspaces.findFirst({
		where: eq(workspaces.id, workspaceId)
	});

	if (!workspace) return false;

	// 2. Personal workspaces & Org owners bypass permission checks
	if (workspace.ownerId === userId) {
		return true;
	}

	// 3. Personal workspaces do not support RBAC roles for other users
	if (workspace.type === "personal") {
		return false;
	}

	// 4. Check Workspace-Level Permissions
	const orgPermissions = await database
		.select({ key: rolePermissions.permissionKey })
		.from(workspaceUserRoles)
		.innerJoin(rolePermissions, eq(workspaceUserRoles.roleId, rolePermissions.roleId))
		.where(
			and(
				eq(workspaceUserRoles.workspaceId, workspaceId),
				eq(workspaceUserRoles.userId, userId),
				eq(rolePermissions.permissionKey, permissionKey)
			)
		)
		.limit(1);

	if (orgPermissions.length > 0) {
		return true;
	}

	// 5. Check Team-Level Permissions (if teamId is provided)
	if (teamId) {
		const teamPerms = await database
			.select({ key: rolePermissions.permissionKey })
			.from(teamUserRoles)
			.innerJoin(rolePermissions, eq(teamUserRoles.roleId, rolePermissions.roleId))
			.where(
				and(
					eq(teamUserRoles.teamId, teamId),
					eq(teamUserRoles.userId, userId),
					eq(rolePermissions.permissionKey, permissionKey)
				)
			)
			.limit(1);

		if (teamPerms.length > 0) {
			return true;
		}
	}

	return false;
}
