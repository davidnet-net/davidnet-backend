import { database } from "../database/client";
import { sql } from "drizzle-orm";

export const checkDatabaseHealth = async () => {
  try {
    const result = await database.execute(sql`SELECT NOW()`);
    console.log(`[Health]: Tested DB health succesfully at: ${result[0].now}`);
  } catch (error) {
    console.error("[Health]: DB unhealthy!");
    console.error(error);
    process.exit(1); 
  }
};