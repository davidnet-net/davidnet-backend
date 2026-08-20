import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth";

// --- EXISTING WORKSPACE & TEAMS ---
export const workspaceTypeEnum = authSchema.enum("workspace_type", ["personal", "organization"]);

export const workspaces = authSchema.table("workspaces", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	ownerId: uuid("owner_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	type: workspaceTypeEnum("type").notNull(),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const teams = authSchema.table("teams", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	workspaceId: uuid("workspace_id")
		.notNull()
		.references(() => workspaces.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- PERMISSIONS TABLE ---
// Global definition of available permission strings (e.g., "kanban:create-board")
export const permissions = authSchema.table("permissions", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	key: text("key").notNull().unique()
});

// --- CUSTOM ROLES TABLE ---
// Defined at the workspace (org) level so org admins can manage them
export const customRoles = authSchema.table("custom_roles", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	workspaceId: uuid("workspace_id")
		.notNull()
		.references(() => workspaces.id, { onDelete: "cascade" }),
	name: text("name").notNull(), // e.g. "Project Admin", "Board Creator"
	description: text("description"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- ROLE PERMISSIONS (Junction) ---
export const rolePermissions = authSchema.table(
	"role_permissions",
	{
		roleId: uuid("role_id")
			.notNull()
			.references(() => customRoles.id, { onDelete: "cascade" }),
		permissionKey: text("permission_key")
			.notNull()
			.references(() => permissions.key, { onDelete: "cascade" })
	},
	(table) => [primaryKey({ columns: [table.roleId, table.permissionKey] })]
);

// --- WORKSPACE USER ROLES ---
// Assigns custom roles to users at the Org level
export const workspaceUserRoles = authSchema.table(
	"workspace_user_roles",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.userId, { onDelete: "cascade" }),
		roleId: uuid("role_id")
			.notNull()
			.references(() => customRoles.id, { onDelete: "cascade" })
	},
	(table) => [primaryKey({ columns: [table.workspaceId, table.userId, table.roleId] })]
);

// --- TEAM USER ROLES ---
// Assigns custom roles to users scoped specifically to a Team
export const teamUserRoles = authSchema.table(
	"team_user_roles",
	{
		teamId: uuid("team_id")
			.notNull()
			.references(() => teams.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.userId, { onDelete: "cascade" }),
		roleId: uuid("role_id")
			.notNull()
			.references(() => customRoles.id, { onDelete: "cascade" })
	},
	(table) => [primaryKey({ columns: [table.teamId, table.userId, table.roleId] })]
);
