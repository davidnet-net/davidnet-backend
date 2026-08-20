import { notInArray } from "drizzle-orm";
import { SYSTEM_PERMISSIONS } from "../../src/core/constants/permissions";
import { database } from "../../src/core/database/client";
import { permissions } from "../../src/core/database/schema/workspaces";

async function syncPermissions() {
	console.log("Syncing permissions to database...");

	// 1. Extract an array of just the valid keys
	const validKeys = SYSTEM_PERMISSIONS.map((perm) => perm.key);

	// 2. Delete any permissions in the DB that aren't in our validKeys array
	// Note: notInArray throws an error if the array is empty, so we check the length first.
	if (validKeys.length > 0) {
		const deletedPerms = await database
			.delete(permissions)
			.where(notInArray(permissions.key, validKeys))
			.returning({ key: permissions.key });

		if (deletedPerms.length > 0) {
			console.log(
				`Removed ${deletedPerms.length} old permissions:`,
				deletedPerms.map((p) => p.key)
			);
		}
	} else {
		// If SYSTEM_PERMISSIONS is entirely empty, delete everything
		await database.delete(permissions);
		console.log("Removed all permissions (SYSTEM_PERMISSIONS is empty).");
	}

	// 3. Insert new permissions (skipping existing ones)
	for (const perm of SYSTEM_PERMISSIONS) {
		console.log(perm);
		await database
			.insert(permissions)
			.values({
				key: perm.key
			})
			.onConflictDoNothing();
	}

	console.log(`Successfully synced ${SYSTEM_PERMISSIONS.length} permissions.`);
	process.exit(0);
}

syncPermissions().catch((err) => {
	console.error("Failed to sync permissions:", err);
	process.exit(1);
});
