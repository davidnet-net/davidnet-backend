import { checkDatabaseHealth } from "./database";

interface healthReportType {
	services: {
		database: boolean;
	};
	isHealthy: boolean;
	date: Date;
}
export const healthReport: healthReportType = {
	services: {
		database: false
	},
	isHealthy: false,
	date: new Date()
};

// Health Report schedular
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
 * Updates the health report. And schedules an new healthBeat after.
 */
async function healthBeat() {
	const databaseHealthy = await checkDatabaseHealth();
	healthReport.services.database = databaseHealthy;

	healthReport.date = new Date();
	healthReport.isHealthy = databaseHealthy; // && other check

	if (healthTimer === null) return;
	setupNextHealthBeat();
}
