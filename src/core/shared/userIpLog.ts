import { database } from "../database/client";
import { userIpLog } from "../database/schema/schema";

// Fire-and-forget (userId, ip) sighting upsert - lets moderators answer "which IPs does this user
// use" / "which users share this IP" for IP-ban decisions. Never throws: a logging failure must
// never break the authenticated request that triggered it.
export async function upsertUserIp(
	userId: string,
	metadata: { ip: string; countryCode: string; userAgent: string } | undefined
) {
	if (!metadata || !metadata.ip || metadata.ip === "Unknown IP") return;

	try {
		await database
			.insert(userIpLog)
			.values({
				userId,
				ip: metadata.ip,
				countryCode: metadata.countryCode,
				userAgent: metadata.userAgent
			})
			.onConflictDoUpdate({
				target: [userIpLog.userId, userIpLog.ip],
				set: {
					countryCode: metadata.countryCode,
					userAgent: metadata.userAgent,
					lastSeenAt: new Date()
				}
			});
	} catch (error) {
		console.error("[UserIpLog]: Failed to record IP sighting:", error);
	}
}
