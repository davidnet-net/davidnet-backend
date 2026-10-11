// src/routes/websockets/community_realtime.ts
//
// Generic real-time extension to the community games SDK: rooms (pub/sub channels) + presence +
// a matchmaking queue primitive. Deliberately content-agnostic - the server never looks at the
// shape of `data` being relayed, so the same primitives work for a 2-player turn-based game, a
// 50+ player shooter, or a one-way broadcast feed (e.g. a live price ticker, published into the
// room by one connected client for everyone else to listen to). There is intentionally no cap on
// room size, queue size, or group size anywhere in this file - only a per-connection
// message-rate/size guard to protect a single pod from a runaway or malicious client, same spirit
// as the anti-cheat rate limiting in community-games.ts.
//
// Cross-pod design: authoritative room membership/state/queues live in Redis (Hashes/Lists), so
// any pod can answer "who's in this room" correctly regardless of which pod a given client's
// socket landed on. Each pod keeps a purely LOCAL cache (`localRoomMembers`) of which of its own
// connected clients are in which room, used only to know who to deliver an incoming pub/sub
// message to - never consulted for membership snapshots, which always come from Redis.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";

import { database } from "../../core/database/client";
import { accountModerationStatus, communityGame, users } from "../../core/database/schema/schema";
import { redis, redisSub } from "../../core/shared/redis";

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
	queues: Set<string>;
	messageTimestamps: number[];
	missedPongs: number;
};

type QueueEntryPayload = {
	connectionId: string;
	member: Member;
	metadata: unknown;
	joinedAt: number;
};

type RoomEnvelope =
	| { scope: "room"; room: string; frame: unknown; exclude: string | null }
	| { scope: "game"; frame: unknown; exclude: string | null }
	| { scope: "matched"; room: string; queue: string; members: Member[]; connectionIds: string[] };

// --- LOCAL (THIS POD ONLY) STATE ---
// Kept in `globalThis` so it survives `bun --hot` reloads in dev, same pattern as the quiz
// websocket routes.
const GLOBAL_STATE_KEY = "__community_realtime_state__";
if (!(globalThis as any)[GLOBAL_STATE_KEY]) {
	(globalThis as any)[GLOBAL_STATE_KEY] = {
		localRoomMembers: new Map<string, Map<string, Set<RealtimeClient>>>(),
		allClients: new Set<RealtimeClient>()
	};
}
const state = (globalThis as any)[GLOBAL_STATE_KEY];
const localRoomMembers: Map<string, Map<string, Set<RealtimeClient>>> = state.localRoomMembers;
const allClients: Set<RealtimeClient> = state.allClients;

// --- REDIS KEYS / CHANNEL ---
const membersKey = (gameId: string, room: string) => `cg:members:${gameId}:${room}`;
const stateKey = (gameId: string, room: string) => `cg:state:${gameId}:${room}`;
const queueKey = (gameId: string, queue: string) => `cg:queue:${gameId}:${queue}`;
const channelFor = (gameId: string) => `cg:game:${gameId}`;
const CHANNEL_PATTERN = "cg:game:*";

function publishEnvelope(gameId: string, envelope: RoomEnvelope) {
	void redis.publish(channelFor(gameId), JSON.stringify(envelope));
}

// Atomically pushes this entry onto the queue and, if that push reached groupSize, pops exactly
// that many entries in the same round trip - two pods racing on the same queue can't both see
// "length >= groupSize" and double-pop overlapping groups, because the whole push-then-maybe-pop
// happens as one Lua script.
const JOIN_QUEUE_SCRIPT = `
redis.call("RPUSH", KEYS[1], ARGV[1])
local len = redis.call("LLEN", KEYS[1])
if len >= tonumber(ARGV[2]) then
  local popped = redis.call("LPOP", KEYS[1], tonumber(ARGV[2]))
  return { len, popped }
else
  return { len, false }
end
`;

// --- PUB/SUB DISPATCH (one subscription per pod, not per room) ---
const GLOBAL_SUBSCRIBE_KEY = "__community_realtime_subscribed__";
if (!(globalThis as any)[GLOBAL_SUBSCRIBE_KEY]) {
	redisSub.psubscribe(CHANNEL_PATTERN).catch((err) => {
		console.error("[CommunityRealtime]: Failed to subscribe to Redis channel:", err);
	});

	redisSub.on("pmessage", (pattern: string, channel: string, message: string) => {
		if (pattern !== CHANNEL_PATTERN) return;
		const gameId = channel.slice("cg:game:".length);

		let envelope: RoomEnvelope;
		try {
			envelope = JSON.parse(message);
		} catch {
			return;
		}

		if (envelope.scope === "room") {
			const members = localRoomMembers.get(gameId)?.get(envelope.room);
			if (!members) return;
			const msgStr = JSON.stringify(envelope.frame);
			for (const member of members) {
				if (member.connectionId === envelope.exclude) continue;
				if (member.ws && member.ws.readyState === 1) member.ws.send(msgStr);
			}
			return;
		}

		if (envelope.scope === "game") {
			const msgStr = JSON.stringify(envelope.frame);
			for (const client of allClients) {
				if (client.gameId !== gameId || client.connectionId === envelope.exclude) continue;
				if (client.ws && client.ws.readyState === 1) client.ws.send(msgStr);
			}
			return;
		}

		if (envelope.scope === "matched") {
			for (const client of allClients) {
				if (client.gameId !== gameId) continue;
				if (!envelope.connectionIds.includes(client.connectionId)) continue;

				getOrCreateLocalRoomSet(gameId, envelope.room).add(client);
				client.rooms.add(envelope.room);
				client.queues.delete(envelope.queue);

				sendTo(client, {
					type: "matched",
					queue: envelope.queue,
					room: envelope.room,
					members: envelope.members
				});
			}
			return;
		}
	});

	(globalThis as any)[GLOBAL_SUBSCRIBE_KEY] = true;
}

// --- HEARTBEAT ---
// The server actively pings every connected client and evicts anyone who stops answering, so a
// dead connection (cable pulled, laptop closed, etc.) is detected quickly instead of relying on a
// TCP-level timeout that can take minutes - which matters here because OTHER players need a
// prompt "presence: leave" event, not just the disconnected client itself.
const HEARTBEAT_TICK_MS = 5000;
const DEAD_MISSED_TICKS = 3; // ~15s of silence before a connection is considered dead

async function cleanupClient(client: RealtimeClient) {
	for (const room of Array.from(client.rooms)) {
		await leaveRoom(client, room);
	}
	await leaveAllQueues(client);
	allClients.delete(client);
}

const GLOBAL_INTERVAL_KEY = "__community_realtime_heartbeat__";
if ((globalThis as any)[GLOBAL_INTERVAL_KEY]) {
	clearInterval((globalThis as any)[GLOBAL_INTERVAL_KEY]);
}
(globalThis as any)[GLOBAL_INTERVAL_KEY] = setInterval(() => {
	for (const client of Array.from(allClients)) {
		if (!client.ws || client.ws.readyState !== 1) {
			void cleanupClient(client);
			continue;
		}

		if (client.missedPongs >= DEAD_MISSED_TICKS) {
			try {
				client.ws.close(4008, "Heartbeat Timeout");
			} catch {}
			void cleanupClient(client);
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
// Per-room cap on distinct setState keys - not a gameplay limit, just a backstop against a room
// accumulating unbounded memory from a buggy or malicious game (e.g. a unique key per tick).
const MAX_STATE_KEYS_PER_ROOM = 500;

function isRateLimited(client: RealtimeClient): boolean {
	const now = Date.now();
	client.messageTimestamps = client.messageTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
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

// --- LOCAL ROOM-TRACKING HELPERS (this pod's own connections only) ---
function getOrCreateLocalRoomSet(gameId: string, room: string): Set<RealtimeClient> {
	let gameRooms = localRoomMembers.get(gameId);
	if (!gameRooms) {
		gameRooms = new Map();
		localRoomMembers.set(gameId, gameRooms);
	}
	let members = gameRooms.get(room);
	if (!members) {
		members = new Set();
		gameRooms.set(room, members);
	}
	return members;
}

function removeLocalRoomSetIfEmpty(gameId: string, room: string) {
	const gameRooms = localRoomMembers.get(gameId);
	if (!gameRooms) return;
	const members = gameRooms.get(room);
	if (members && members.size === 0) gameRooms.delete(room);
	if (gameRooms.size === 0) localRoomMembers.delete(gameId);
}

function sendTo(client: RealtimeClient, frame: unknown) {
	if (client.ws && client.ws.readyState === 1) {
		client.ws.send(JSON.stringify(frame));
	}
}

async function joinRoom(client: RealtimeClient, room: string) {
	await redis.hset(
		membersKey(client.gameId, room),
		client.connectionId,
		JSON.stringify(client.member)
	);
	getOrCreateLocalRoomSet(client.gameId, room).add(client);
	client.rooms.add(room);
}

async function leaveRoom(client: RealtimeClient, room: string) {
	if (!client.rooms.has(room)) return;
	client.rooms.delete(room);
	getOrCreateLocalRoomSet(client.gameId, room).delete(client);
	removeLocalRoomSetIfEmpty(client.gameId, room);

	await redis.hdel(membersKey(client.gameId, room), client.connectionId);
	publishEnvelope(client.gameId, {
		scope: "room",
		room,
		frame: { type: "presence", room, event: "leave", member: client.member },
		exclude: null
	});

	// Two pods racing to both notice "empty" and both issue DEL is harmless - idempotent.
	const remaining = await redis.hlen(membersKey(client.gameId, room));
	if (remaining === 0) {
		await redis.del(membersKey(client.gameId, room));
		await redis.del(stateKey(client.gameId, room));
	}
}

async function leaveAllQueues(client: RealtimeClient) {
	for (const queueName of Array.from(client.queues)) {
		await leaveQueueEntry(client, queueName);
	}
}

async function leaveQueueEntry(client: RealtimeClient, queueName: string) {
	client.queues.delete(queueName);
	const key = queueKey(client.gameId, queueName);
	const entries = await redis.lrange(key, 0, -1);
	for (const raw of entries) {
		let parsed: QueueEntryPayload;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (parsed.connectionId === client.connectionId) {
			await redis.lrem(key, 1, raw);
			break;
		}
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
		// Always present: this callback only runs after the preceding middleware matched the same
		// "/:gameId/realtime" route and validated the game exists.
		const gameId = c.req.param("gameId")!;
		const member = c.get("member");

		const client: RealtimeClient = {
			ws: null,
			connectionId: crypto.randomUUID(),
			gameId,
			member,
			rooms: new Set(),
			queues: new Set(),
			messageTimestamps: [],
			missedPongs: 0
		};

		return {
			onOpen(_event, ws) {
				client.ws = ws;
				allClients.add(client);
			},

			async onMessage(event, ws) {
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

						const [rawMembers, rawState] = await Promise.all([
							redis.hgetall(membersKey(gameId, room)),
							redis.hgetall(stateKey(gameId, room))
						]);
						const snapshot = Object.values(rawMembers).map((m) => JSON.parse(m) as Member);
						const stateSnapshot = Object.fromEntries(
							Object.entries(rawState).map(([k, v]) => [k, JSON.parse(v)])
						);

						await joinRoom(client, room);

						sendTo(client, {
							type: "ack",
							reqId,
							ok: true,
							room,
							members: snapshot,
							state: stateSnapshot
						});
						publishEnvelope(gameId, {
							scope: "room",
							room,
							frame: { type: "presence", room, event: "join", member: client.member },
							exclude: client.connectionId
						});
						return;
					}

					case "leave": {
						const room = typeof data.room === "string" ? data.room : "";
						await leaveRoom(client, room);
						sendTo(client, { type: "ack", reqId, ok: true, room });
						return;
					}

					case "roomInfo": {
						const room = typeof data.room === "string" ? data.room.slice(0, 200) : "";
						if (!room) {
							sendTo(client, { type: "ack", reqId, ok: false, code: "INVALID_ROOM" });
							return;
						}

						// Deliberately does NOT join the room or create it - just a read-only peek, same
						// info a joiner would see in their own join ack's "members" field. Always reads
						// from Redis, so it's correct regardless of which pod each member is connected to.
						const rawMembers = await redis.hgetall(membersKey(gameId, room));
						const snapshot = Object.values(rawMembers).map((m) => JSON.parse(m) as Member);

						sendTo(client, {
							type: "ack",
							reqId,
							ok: true,
							room,
							memberCount: snapshot.length,
							members: snapshot
						});
						return;
					}

					case "setState": {
						const room = typeof data.room === "string" ? data.room : "";
						if (!room || !client.rooms.has(room)) {
							sendTo(client, {
								type: "error",
								code: "NOT_IN_ROOM",
								message: `Not joined to room "${room}"`
							});
							return;
						}

						const key = typeof data.key === "string" ? data.key.slice(0, 200) : "";
						if (!key) {
							sendTo(client, { type: "ack", reqId, ok: false, code: "INVALID_KEY" });
							return;
						}

						const sKey = stateKey(gameId, room);
						const alreadyHasKey = await redis.hexists(sKey, key);
						if (!alreadyHasKey) {
							const keyCount = await redis.hlen(sKey);
							if (keyCount >= MAX_STATE_KEYS_PER_ROOM) {
								sendTo(client, { type: "ack", reqId, ok: false, code: "STATE_LIMIT_REACHED" });
								return;
							}
						}

						await redis.hset(sKey, key, JSON.stringify(data.value));
						sendTo(client, { type: "ack", reqId, ok: true, room, key });
						publishEnvelope(gameId, {
							scope: "room",
							room,
							frame: { type: "state", room, key, value: data.value, from: client.member },
							exclude: client.connectionId
						});
						return;
					}

					case "announce": {
						const frame = {
							type: "announcement",
							data: data.data,
							from: client.member,
							ts: Date.now()
						};
						publishEnvelope(gameId, {
							scope: "game",
							frame,
							exclude: data.echo ? null : client.connectionId
						});
						sendTo(client, { type: "ack", reqId, ok: true });
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
						publishEnvelope(gameId, {
							scope: "room",
							room,
							frame,
							exclude: data.echo ? null : client.connectionId
						});
						return;
					}

					case "joinQueue": {
						const queueName = typeof data.queue === "string" ? data.queue.slice(0, 200) : "";
						const groupSize = Number(data.groupSize);
						if (!queueName || !Number.isInteger(groupSize) || groupSize < 1) {
							sendTo(client, { type: "ack", reqId, ok: false, code: "INVALID_QUEUE" });
							return;
						}

						client.queues.add(queueName);
						const entry: QueueEntryPayload = {
							connectionId: client.connectionId,
							member: client.member,
							metadata: data.metadata,
							joinedAt: Date.now()
						};

						const [len, popped] = (await redis.eval(
							JOIN_QUEUE_SCRIPT,
							1,
							queueKey(gameId, queueName),
							JSON.stringify(entry),
							String(groupSize)
						)) as [number, string[] | false];

						sendTo(client, {
							type: "ack",
							reqId,
							ok: true,
							queue: queueName,
							position: len
						});

						// Group-of-N FIFO matching. `groupSize` is treated as a property of the queue name
						// itself - callers joining the same queue should agree on the same size.
						if (popped) {
							const matched = popped.map((raw) => JSON.parse(raw) as QueueEntryPayload);
							const room = crypto.randomUUID();
							const members = matched.map((e) => e.member);
							const connectionIds = matched.map((e) => e.connectionId);

							// Pre-seed membership in Redis so a HGETALL/roomInfo from any pod sees the full
							// matched group immediately, even before each pod's own "matched" dispatch (below)
							// finishes joining its local clients.
							const membersEntries: Record<string, string> = {};
							for (const e of matched) membersEntries[e.connectionId] = JSON.stringify(e.member);
							if (Object.keys(membersEntries).length > 0) {
								await redis.hset(membersKey(gameId, room), membersEntries);
							}

							publishEnvelope(gameId, {
								scope: "matched",
								room,
								queue: queueName,
								members,
								connectionIds
							});
						}
						return;
					}

					case "leaveQueue": {
						const queueName = typeof data.queue === "string" ? data.queue : "";
						await leaveQueueEntry(client, queueName);
						sendTo(client, { type: "ack", reqId, ok: true, queue: queueName });
						return;
					}

					case "queueInfo": {
						const queueName = typeof data.queue === "string" ? data.queue.slice(0, 200) : "";
						if (!queueName) {
							sendTo(client, { type: "ack", reqId, ok: false, code: "INVALID_QUEUE" });
							return;
						}

						// Deliberately does NOT join the queue - just a read-only peek.
						const waiting = await redis.llen(queueKey(gameId, queueName));
						sendTo(client, {
							type: "ack",
							reqId,
							ok: true,
							queue: queueName,
							waiting
						});
						return;
					}
				}
			},

			onClose() {
				void cleanupClient(client);
			}
		};
	})
);

// Called from src/index.ts's graceful shutdown sequence (via routes/websockets/drain.ts). Best
// effort: release this pod's membership for every locally-connected client, then close their
// sockets with a reconnect hint so they move to whichever pod survives.
export async function releaseAndDrain() {
	const clients = Array.from(allClients);
	for (const client of clients) {
		sendTo(client, { type: "reconnect", code: 4100, message: "Server restarting" });
	}
	await Promise.allSettled(clients.map((client) => cleanupClient(client)));
	for (const client of clients) {
		try {
			client.ws?.close(4100, "Server restarting");
		} catch {}
	}
}
