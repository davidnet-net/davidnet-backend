import { eq, inArray } from "drizzle-orm";

import { database } from "../database/client";
import { users } from "../database/schema/schema";

// Fire-and-forget activity feed for the team Discord - lets moderators/devs see content and
// account churn as it happens without having to poll the moderation screens. Never throws: a
// misconfigured or unreachable webhook must not break the request that triggered it.
//
// `targetUserId` is who the action was done TO (e.g. the banned user, the owner of moderated
// content) when that's someone other than the actor - resolved to a readable @username/display
// name the same way the actor is, instead of callers passing a raw userId as a plain field.
export async function notifyActivity(
	event: string,
	actorUserId: string,
	fields: Record<string, string | null | undefined> = {},
	targetUserId?: string
) {
	const webhookUrl = Bun.env.DISCORD_ACTIVITY_WEBHOOK_URL;
	if (!webhookUrl) return;

	try {
		const hasDistinctTarget = Boolean(targetUserId && targetUserId !== actorUserId);
		const idsToResolve = hasDistinctTarget ? [actorUserId, targetUserId!] : [actorUserId];

		const resolved = await database
			.select({ userId: users.userId, username: users.username, displayName: users.displayName })
			.from(users)
			.where(inArray(users.userId, idsToResolve));

		const labelFor = (id: string) => {
			const match = resolved.find((u) => u.userId === id);
			return match ? `@${match.username} (${match.displayName})` : id;
		};

		const actorLabel = labelFor(actorUserId);

		const embedFields = Object.entries(fields)
			.filter(([, value]) => value !== undefined && value !== null && value !== "")
			.map(([name, value]) => ({ name, value: String(value), inline: true }));

		if (hasDistinctTarget) {
			embedFields.unshift({ name: "Target", value: labelFor(targetUserId!), inline: true });
		}

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
