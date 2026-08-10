import { checkDatabaseHealth } from "./database";
import { checkS3Health } from "./s3";

interface healthReportType {
	services: {
		database: boolean;
		s3: boolean; // Fixed type from false to boolean
	};
	isHealthy: boolean;
	date: Date;
}

export const healthReport: healthReportType = {
	services: {
		database: false,
		s3: false
	},
	isHealthy: false,
	date: new Date()
};

let healthTimer: ReturnType<typeof setTimeout> | null = null;

export function setupNextHealthBeat() {
	if (healthTimer) clearTimeout(healthTimer);

	healthTimer = setTimeout(healthBeat, 10000);
}

export function stopHealthBeat() {
	if (healthTimer) {
		clearTimeout(healthTimer);
	}
	healthTimer = null;
}

/**
 * Updates the health report and schedules a new healthBeat after.
 */
async function healthBeat() {
	try {
		const databaseHealthy = await checkDatabaseHealth();
		const s3Healthy = await checkS3Health();

		healthReport.services.database = databaseHealthy;
		healthReport.services.s3 = s3Healthy;

		healthReport.date = new Date();
		healthReport.isHealthy = databaseHealthy && s3Healthy;
	} catch (error) {
		console.error("Error running health check beat:", error);
		healthReport.isHealthy = false;
		healthReport.date = new Date();
	} finally {
		if (healthTimer !== null) {
			setupNextHealthBeat();
		}
	}
}
