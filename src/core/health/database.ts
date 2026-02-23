import { database } from "../database/client";
import { sql } from "drizzle-orm";

export const checkDatabaseHealth = async () => {
  try {
    await database.execute(sql`SELECT NOW()`);
    return true
  } catch (error) {
    console.error("[Health]: DB unhealthy!");
    console.error(error);
    return false
  }
};