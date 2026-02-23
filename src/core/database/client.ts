import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = Bun.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("[Database]: DATABASE_URL is not defined in environment variables");
}

const queryClient = postgres(connectionString);

export const database = drizzle(queryClient, { schema });

export const closeDbConnection = async (): Promise<void> => {
  console.log("[Database]: Closing database connection...");
  try {
    await queryClient.end();
    console.log("[Database]: Connection closed successfully.");
  } catch (error) {
    console.error("[Database]: Error closing database connection:", error);
    throw error;
  }
};