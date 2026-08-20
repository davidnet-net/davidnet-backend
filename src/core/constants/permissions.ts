export const SYSTEM_PERMISSIONS = [{ key: "quiz:create" }] as const;

export type PermissionKey = (typeof SYSTEM_PERMISSIONS)[number]["key"];
