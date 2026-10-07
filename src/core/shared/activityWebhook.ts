import { eq } from "drizzle-orm";

import { database } from "../database/client";
import { users } from "../database/schema/schema";

// Fire-and-forget activity feed for the team Discord - lets moderators/devs see content and
// account churn as it happens without having to poll the moderation screens. Never throws: a
// misconfigured or unreachable webhook must not break the request that triggered it.
export async function notifyActivity(
	event: string,
	userId: string,
	fields: Record<string, string | null | undefined> = {}
) {
	const webhookUrl = Bun.env.DISCORD_ACTIVITY_WEBHOOK_URL;
	if (!webhookUrl) return;

	try {
		const [actor] = await database
			.select({ username: users.username, displayName: users.displayName })
			.from(users)
			.where(eq(users.userId, userId))
			.limit(1);

		const actorLabel = actor ? `@${actor.username} (${actor.displayName})` : userId;

		const embedFields = Object.entries(fields)
			.filter(([, value]) => value !== undefined && value !== null && value !== "")
			.map(([name, value]) => ({ name, value: String(value), inline: true }));

		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				embeds: [
					{
						title: event,
						description: `By **${actorLabel}**`,
						color: 0x5865f2,
						fields: embedFields,
						timestamp: new Date().toISOString()
					}
				]
			})
		});

		// fetch only rejects on network failure - a bad/revoked webhook token comes back as a
		// normal 2xx-less HTTP response, so without this check a dead webhook fails silently.
		if (!response.ok) {
			console.error(
				`[ActivityWebhook]: Discord rejected "${event}" (${response.status}):`,
				await response.text()
			);
			return;
		}

		console.log(`[ActivityWebhook]: Sent "${event}" for ${actorLabel}`);
	} catch (error) {
		console.error("[ActivityWebhook]: Failed to send Discord notification:", error);
	}
}
