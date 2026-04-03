import { sql } from "drizzle-orm";

import { database } from "../database/client";

export const checkDatabaseHealth = async () => {
	try {
		await database.execute(sql`SELECT NOW()`);
		return true;
	} catch (error) {
		console.error("[Health]: DB unhealthy!");
		console.error(error);
		return false;
	}
};
