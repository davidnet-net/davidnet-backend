export const SYSTEM_PERMISSIONS = [
	// Quiz Management
	{ key: "quiz:create" },
	{ key: "quiz:list" },
	{ key: "quiz:read" },
	{ key: "quiz:edit" },
	{ key: "quiz:delete" },

	// Live Sessions
	{ key: "quiz:session:start" },
	{ key: "quiz:session:manage" },

	// Analytics
	{ key: "quiz:results:read" },
	{ key: "quiz:results:delete" }
] as const;

export type PermissionKey = (typeof SYSTEM_PERMISSIONS)[number]["key"];
