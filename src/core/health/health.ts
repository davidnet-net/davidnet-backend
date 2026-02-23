import { checkDatabaseHealth } from "./db_check";

/**
 * Runs all health checks
 */
export async function healthCheck() {
    await checkDatabaseHealth();
}