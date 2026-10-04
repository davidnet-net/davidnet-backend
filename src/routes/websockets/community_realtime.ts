// src/routes/websockets/community_realtime.ts
//
// Generic real-time extension to the community games SDK: rooms (pub/sub channels) + presence +
// a matchmaking queue primitive. Deliberately content-agnostic - the server never looks at the
// shape of `data` being relayed, so the same primitives work for a 2-player turn-based game, a
// 50+ player shooter, or a one-way broadcast feed (e.g. a live price ticker, published into the
// room by one connected client for everyone else to listen to). There is intentionally no cap on
// room size, queue size, or group size anywhere in this file - only a per-connection
// message-rate/size guard to protect this single backend instance from a runaway or malicious
// client, same spirit as the anti-cheat rate limiting in community-games.ts.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";

import { database } from "../../core/database/client";
import { accountModerationStatus, communityGame, users } from "../../core/database/schema/schema";

// --- TYPES ---
type Member = {
	userId: string;
	username: string;
	displayName: string;
	avatarUrl: string | null;
};

type RealtimeClient = {
	ws: any;
	connectionId: string;
	gameId: string;
	member: Member;
	rooms: Set<string>;
	messageTimestamps: number[];
	missedPongs: number;
};

type QueueEntry = {
	client: RealtimeClient;
	metadata: unknown;
	joinedAt: number;
};

// --- IN-MEMORY STATE ---
// Single backend instance only (no replicas today - see Helm chart). Kept in `globalThis` so it
// survives `bun --hot` reloads in dev, same pattern as the quiz websocket routes.
const GLOBAL_STATE_KEY = "__community_realtime_state__";
if (!(globalThis as any)[GLOBAL_STATE_KEY]) {
	(globalThis as any)[GLOBAL_STATE_KEY] = {
		roomMembers: new Map<string, Map<string, Set<RealtimeClient>>>(),
		queues: new Map<string, Map<string, QueueEntry[]>>(),
		allClients: new Set<RealtimeClient>()
	};
}
const state = (globalThis as any)[GLOBAL_STATE_KEY];
const roomMembers: Map<string, Map<string, Set<RealtimeClient>>> = state.roomMembers;
const queues: Map<string, Map<string, QueueEntry[]>> = state.queues;
const allClients: Set<RealtimeClient> = state.allClients;

// --- HEARTBEAT ---
// The server actively pings every connected client and evicts anyone who stops answering, so a
// dead connection (cable pulled, laptop closed, etc.) is detected quickly instead of relying on a
// TCP-level timeout that can take minutes - which matters here because OTHER players need a
// prompt "presence: leave" event, not just the disconnected client itself.
const HEARTBEAT_TICK_MS = 5000;
const DEAD_MISSED_TICKS = 3; // ~15s of silence before a connection is considered dead

function cleanupClient(client: RealtimeClient) {
	for (const room of Array.from(client.rooms)) {
		leaveRoom(client, room);
	}
	leaveAllQueues(client);
	allClients.delete(client);
}

const GLOBAL_INTERVAL_KEY = "__community_realtime_heartbeat__";
if ((globalThis as any)[GLOBAL_INTERVAL_KEY]) {
	clearInterval((globalThis as any)[GLOBAL_INTERVAL_KEY]);
}
(globalThis as any)[GLOBAL_INTERVAL_KEY] = setInterval(() => {
	for (const client of Array.from(allClients)) {
		if (!client.ws || client.ws.readyState !== 1) {
			cleanupClient(client);
			continue;
		}

		if (client.missedPongs >= DEAD_MISSED_TICKS) {
			try {
				client.ws.close(4008, "Heartbeat Timeout");
			} catch {}
			cleanupClient(client);
			continue;
		}

		client.missedPongs += 1;
		sendTo(client, { type: "ping" });
	}
}, HEARTBEAT_TICK_MS);

// --- STABILITY SAFEGUARDS ---
// Not a multiplayer-size limit (there is none, by design) - just abuse/runaway-loop protection.
const MAX_MESSAGE_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 200;

function isRateLimited(client: RealtimeClient): boolean {
	const now = Date.now();
	client.messageTimestamps = client.messageTimestamps.filter(
		(t) => now - t < RATE_LIMIT_WINDOW_MS
	);
	if (client.messageTimestamps.length >= RATE_LIMIT_MAX_MESSAGES) return true;
	client.messageTimestamps.push(now);
	return false;
}

// --- AUTH (cookie-based JWT, mirroring quiz_edit.ts - WS upgrade requests can't carry a custom
// Authorization header, so this can't reuse the requireAuth middleware) ---
async function checkAuth(token: string | undefined) {
	if (!token) return false;
	const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
	if (!ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is not configured");

	try {
		const payload = await verify(token, ACCESS_SECRET, "HS256");
		if (payload.type && payload.type !== "access") return false;
		const userID = payload.userID as string;
		if (!userID) return false;
		return { userID };
	} catch {
		return false;
	}
}

async function isBanned(userId: string): Promise<boolean> {
	try {
		const [status] = await database
			.select({ bannedUntil: accountModerationStatus.bannedUntil })
			.from(accountModerationStatus)
			.where(eq(accountModerationStatus.userId, userId))
			.limit(1);

		if (!status || !status.bannedUntil) return false;
		return new Date(status.bannedUntil).getTime() > Date.now();
	} catch {
		return false;
	}
}

// --- ROOM HELPERS ---
function getOrCreateRoom(gameId: string, room: string): Set<RealtimeClient> {
	let gameRooms = roomMembers.get(gameId);
	if (!gameRooms) {
		gameRooms = new Map();
		roomMembers.set(gameId, gameRooms);
	}
	let members = gameRooms.get(room);
	if (!members) {
		members = new Set();
		gameRooms.set(room, members);
	}
	return members;
}

function removeRoomIfEmpty(gameId: string, room: string) {
	const gameRooms = roomMembers.get(gameId);
	if (!gameRooms) return;
	const members = gameRooms.get(room);
	if (members && members.size === 0) gameRooms.delete(room);
	if (gameRooms.size === 0) roomMembers.delete(gameId);
}

function sendTo(client: RealtimeClient, frame: unknown) {
	if (client.ws && client.ws.readyState === 1) {
		client.ws.send(JSON.stringify(frame));
	}
}

function broadcastToRoomMembers(
	gameId: string,
	room: string,
	frame: unknown,
	exclude?: RealtimeClient
) {
	const members = roomMembers.get(gameId)?.get(room);
	if (!members) return;
	const msgStr = JSON.stringify(frame);
	for (const member of members) {
		if (member === exclude) continue;
		if (member.ws && member.ws.readyState === 1) member.ws.send(msgStr);
	}
}

function leaveRoom(client: RealtimeClient, room: string) {
	if (!client.rooms.has(room)) return;
	client.rooms.delete(room);
	roomMembers.get(client.gameId)?.get(room)?.delete(client);
	broadcastToRoomMembers(client.gameId, room, {
		type: "presence",
		room,
		event: "leave",
		member: client.member
	});
	removeRoomIfEmpty(client.gameId, room);
}

function leaveAllQueues(client: RealtimeClient) {
	const gameQueues = queues.get(client.gameId);
	if (!gameQueues) return;
	for (const entries of gameQueues.values()) {
		const idx = entries.findIndex((e) => e.client === client);
		if (idx !== -1) entries.splice(idx, 1);
	}
}

// --- ROUTE ---
export const communityRealtimeWs = new Hono<{
	Variables: {
		member: Member;
	};
}>();

communityRealtimeWs.get(
	"/:gameId/realtime",
	async (c, next) => {
		const gameId = c.req.param("gameId");
		const token = getCookie(c, "access_token");
		const authResult = await checkAuth(token);
		if (!authResult) return c.text("Unauthorized", 401);

		if (await isBanned(authResult.userID)) {
			return c.text("Forbidden", 403);
		}

		const [game] = await database
			.select({ id: communityGame.id })
			.from(communityGame)
			.where(eq(communityGame.id, gameId))
			.limit(1);

		if (!game) return c.text("Game not found", 404);

		const [userRecord] = await database
			.select({
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl
			})
			.from(users)
			.where(eq(users.userId, authResult.userID))
			.limit(1);

		if (!userRecord) return c.text("Unauthorized", 401);

		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			return c.json({ success: true }, 200);
		}

		c.set("member", {
			userId: authResult.userID,
			username: userRecord.username,
			displayName: userRecord.displayName,
			avatarUrl: userRecord.avatarUrl
		});

		await next();
	},
	upgradeWebSocket((c) => {
		const gameId = c.req.param("gameId");
		const member = c.get("member");

		const client: RealtimeClient = {
			ws: null,
			connectionId: crypto.randomUUID(),
			gameId,
			member,
			rooms: new Set(),
			messageTimestamps: [],
			missedPongs: 0
		};

		return {
			onOpen(_event, ws) {
				client.ws = ws;
				allClients.add(client);
			},

			onMessage(event, ws) {
				client.ws = ws;

				const raw = typeof event.data === "string" ? event.data : event.data.toString();
				if (raw.length > MAX_MESSAGE_BYTES) {
					sendTo(client, {
						type: "error",
						code: "MESSAGE_TOO_LARGE",
						message: `Message exceeds the ${MAX_MESSAGE_BYTES} byte limit`
					});
					return;
				}

				if (isRateLimited(client)) {
					sendTo(client, {
						type: "error",
						code: "RATE_LIMITED",
						message: "Too many messages - slow down"
					});
					return;
				}

				let data: any;
				try {
					data = JSON.parse(raw);
				} catch {
					return;
				}

				// Any well-formed frame counts as proof of life, not just an explicit "pong".
				client.missedPongs = 0;

				const reqId = typeof data.reqId === "string" ? data.reqId : undefined;

				switch (data.type) {
					case "ping": {
						sendTo(client, { type: "pong" });
						return;
					}

					// Reply to the server's own heartbeat ping. No-op beyond the proof-of-life reset
					// above - kept as an explicit case so it doesn't fall through unnoticed.
					case "pong": {
						return;
					}

					case "join": {
						const room = typeof data.room === "string" ? data.room.slice(0, 200) : "";
						if (!room) {
							sendTo(client, { type: "ack", reqId, ok: false, code: "INVALID_ROOM" });
							return;
						}

						const members = getOrCreateRoom(gameId, room);
						const snapshot = Array.from(members).map((m) => m.member);
						members.add(client);
						client.rooms.add(room);

						sendTo(client, { type: "ack", reqId, ok: true, room, members: snapshot });
						broadcastToRoomMembers(
							gameId,
							room,
							{ type: "presence", room, event: "join", member: client.member },
							client
						);
						return;
					}

					case "leave": {
						const room = typeof data.room === "string" ? data.room : "";
						leaveRoom(client, room);
						sendTo(client, { type: "ack", reqId, ok: true, room });
						return;
					}

					case "send": {
						const room = typeof data.room === "string" ? data.room : "";
						if (!room || !client.rooms.has(room)) {
							sendTo(client, {
								type: "error",
								code: "NOT_IN_ROOM",
								message: `Not joined to room "${room}"`
							});
							return;
						}

						const frame = {
							type: "message",
							room,
							data: data.data,
							from: client.member,
							ts: Date.now()
						};
						broadcastToRoomMembers(gameId, room, frame, data.echo ? undefined : client);
						return;
					}

					case "joinQueue": {
						const queueName = typeof data.queue === "string" ? data.queue.slice(0, 200) : "";
						const groupSize = Number(data.groupSize);
						if (!queueName || !Number.isInteger(groupSize) || groupSize < 1) {
							sendTo(client, { type: "ack", reqId, ok: false, code: "INVALID_QUEUE" });
							return;
						}

						let gameQueues = queues.get(gameId);
						if (!gameQueues) {
							gameQueues = new Map();
							queues.set(gameId, gameQueues);
						}
						let entries = gameQueues.get(queueName);
						if (!entries) {
							entries = [];
							gameQueues.set(queueName, entries);
						}

						if (!entries.some((e) => e.client === client)) {
							entries.push({ client, metadata: data.metadata, joinedAt: Date.now() });
						}

						sendTo(client, {
							type: "ack",
							reqId,
							ok: true,
							queue: queueName,
							position: entries.length
						});

						// Group-of-N FIFO matching. `groupSize` is treated as a property of the queue name
						// itself - callers joining the same queue should agree on the same size.
						if (entries.length >= groupSize) {
							const matched = entries.splice(0, groupSize);
							const room = crypto.randomUUID();
							const members = matched.map((e) => e.client.member);

							for (const entry of matched) {
								getOrCreateRoom(gameId, room).add(entry.client);
								entry.client.rooms.add(room);
								sendTo(entry.client, { type: "matched", queue: queueName, room, members });
							}
						}
						return;
					}

					case "leaveQueue": {
						const queueName = typeof data.queue === "string" ? data.queue : "";
						const entries = queues.get(gameId)?.get(queueName);
						if (entries) {
							const idx = entries.findIndex((e) => e.client === client);
							if (idx !== -1) entries.splice(idx, 1);
						}
						sendTo(client, { type: "ack", reqId, ok: true, queue: queueName });
						return;
					}
				}
			},

			onClose() {
				cleanupClient(client);
			}
		};
	})
);
