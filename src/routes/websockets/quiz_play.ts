// src/websockets/quiz_play.ts
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { database } from "../../core/database/client";
import { quizSessions, sessionParticipants } from "../../core/database/schema/quiz";
import { eq } from "drizzle-orm";
import { broadcastToPresenters } from "./quiz_present";

type PlayerConnection = {
	ws: any;
	sessionId: string;
	participantId: string;
	tickAge: number;
	missedPongs: number;
	connectionId: string;
};

export const playWs = new Hono<{
	Variables: {
		session: any;
	};
}>();

const GLOBAL_STATE_KEY = "__quiz_play_state__";
if (!(globalThis as any)[GLOBAL_STATE_KEY]) {
	(globalThis as any)[GLOBAL_STATE_KEY] = {
		wsByParticipant: new Map<string, PlayerConnection>(),
		blockedNicknamesBySession: new Map<string, Set<string>>(),
		disconnectGracePeriods: new Map<string, ReturnType<typeof setTimeout>>()
	};
}
const state = (globalThis as any)[GLOBAL_STATE_KEY] as {
	wsByParticipant: Map<string, PlayerConnection>;
	blockedNicknamesBySession: Map<string, Set<string>>;
	disconnectGracePeriods: Map<string, ReturnType<typeof setTimeout>>;
};

export const wsByParticipant = state.wsByParticipant;
export const blockedNicknamesBySession = state.blockedNicknamesBySession;
const disconnectGracePeriods = state.disconnectGracePeriods;

const HEARTBEAT_TICK_MS = 5000;
const INITIAL_GRACE_TICKS = 3;
const FAILING_MISSED_TICKS = 3;
const DEAD_MISSED_TICKS = 6;

const GLOBAL_INTERVAL_KEY = "__quiz_heartbeat_interval__";
if ((globalThis as any)[GLOBAL_INTERVAL_KEY]) {
	clearInterval((globalThis as any)[GLOBAL_INTERVAL_KEY]);
}

(globalThis as any)[GLOBAL_INTERVAL_KEY] = setInterval(() => {
	const deadSockets: PlayerConnection[] = [];

	wsByParticipant.forEach((conn, participantId) => {
		try {
			if (!conn.ws || conn.ws.readyState !== 1) {
				deadSockets.push(conn);
				return;
			}

			conn.ws.send(JSON.stringify({ type: "PING" }));

			conn.tickAge += 1;
			if (conn.tickAge <= INITIAL_GRACE_TICKS) {
				return;
			}

			conn.missedPongs += 1;

			if (conn.missedPongs >= DEAD_MISSED_TICKS) {
				deadSockets.push(conn);
			} else {
				broadcastToPresenters(conn.sessionId, {
					type: "PLAYER_HEALTH_UPDATE",
					payload: { id: participantId, failingHeartbeat: conn.missedPongs >= FAILING_MISSED_TICKS }
				});
			}
		} catch (err) {
			deadSockets.push(conn);
		}
	});

	for (const conn of deadSockets) {
		if (conn.ws) {
			try {
				conn.ws.close(4008, "Heartbeat Timeout");
			} catch {}
		}
		handleSocketDisconnection(conn.participantId, conn.sessionId, conn.connectionId);
	}
}, HEARTBEAT_TICK_MS);

export async function terminateParticipant(participantId: string, sessionId: string) {
	if (!wsByParticipant.has(participantId) && !disconnectGracePeriods.has(participantId)) return;

	wsByParticipant.delete(participantId);

	if (disconnectGracePeriods.has(participantId)) {
		clearTimeout(disconnectGracePeriods.get(participantId)!);
		disconnectGracePeriods.delete(participantId);
	}

	await database
		.delete(sessionParticipants)
		.where(eq(sessionParticipants.id, participantId))
		.catch(() => {});

	broadcastToPresenters(sessionId, { type: "PLAYER_LEFT", payload: { id: participantId } });
}

export async function kickParticipant(playerId: string, sessionId: string, nickname: string) {
	if (!blockedNicknamesBySession.has(sessionId)) {
		blockedNicknamesBySession.set(sessionId, new Set());
	}
	blockedNicknamesBySession.get(sessionId)!.add(nickname.toLowerCase());

	const conn = wsByParticipant.get(playerId);
	if (conn && conn.ws) {
		if (conn.ws.readyState === 1) {
			conn.ws.send(
				JSON.stringify({
					type: "KICKED",
					message: "You have been removed from the quiz by the host."
				})
			);
			try {
				conn.ws.close(4001, "Kicked");
			} catch {}
		}
	}
	await terminateParticipant(playerId, sessionId);
}

export async function terminateSessionPlayers(
	sessionId: string,
	reason: string = "The host has ended the presentation."
) {
	const participants = await database
		.select()
		.from(sessionParticipants)
		.where(eq(sessionParticipants.sessionId, sessionId));

	for (const p of participants) {
		const conn = wsByParticipant.get(p.id);
		if (conn && conn.ws && conn.ws.readyState === 1) {
			conn.ws.send(JSON.stringify({ type: "SESSION_TERMINATED", message: reason }));
			try {
				conn.ws.close(4001, "Session Terminated");
			} catch {}
		}
		await terminateParticipant(p.id, sessionId);
	}

	await database
		.delete(quizSessions)
		.where(eq(quizSessions.id, sessionId))
		.catch(() => {});
}

function handleSocketDisconnection(participantId: string, sessionId: string, connectionId: string) {
	const currentConn = wsByParticipant.get(participantId);
	if (currentConn && currentConn.connectionId !== connectionId) return;

	broadcastToPresenters(sessionId, {
		type: "PLAYER_HEALTH_UPDATE",
		payload: { id: participantId, failingHeartbeat: true }
	});

	if (disconnectGracePeriods.has(participantId)) return;

	// Grace period lowered to 7 seconds to quickly kick users who close the tab
	const timeout = setTimeout(async () => {
		disconnectGracePeriods.delete(participantId);
		const activeConn = wsByParticipant.get(participantId);
		if (!activeConn || activeConn.connectionId === connectionId) {
			await terminateParticipant(participantId, sessionId);
		}
	}, 7000);

	disconnectGracePeriods.set(participantId, timeout);
}

playWs.post("/leave/:participantId", async (c) => {
	const participantId = c.req.param("participantId");
	if (!participantId) return c.json({ error: "Missing participant ID" }, 400);

	const [participant] = await database
		.select()
		.from(sessionParticipants)
		.where(eq(sessionParticipants.id, participantId))
		.limit(1);

	if (participant) {
		const conn = wsByParticipant.get(participantId);
		if (conn && conn.ws) {
			try {
				conn.ws.close(1000, "User Left via HTTP");
			} catch {}
		}
		await terminateParticipant(participantId, participant.sessionId);
	}
	return c.json({ success: true });
});

playWs.get(
	"/:pin",
	async (c, next) => {
		const pin = c.req.param("pin");
		const participantId = c.req.query("participantId");

		if (!pin || pin.length !== 6) {
			return c.json({ error: "Invalid PIN format" }, 400);
		}

		const [session] = await database
			.select()
			.from(quizSessions)
			.where(eq(quizSessions.pinCode, pin))
			.limit(1);

		if (!session) {
			return c.json({ error: "Quiz not found or invalid PIN" }, 404);
		}

		if (session.locked) {
			return c.json({ error: "This quiz session is locked by the host." }, 403);
		}

		if (session.status !== "lobby") {
			return c.json({ error: "This quiz has already started or finished." }, 403);
		}

		if (participantId) {
			const [participant] = await database
				.select()
				.from(sessionParticipants)
				.where(eq(sessionParticipants.id, participantId))
				.limit(1);

			if (!participant && !disconnectGracePeriods.has(participantId)) {
				return c.json({ error: "You have been removed from the session." }, 403);
			}
		}

		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			return c.json({ success: true, sessionId: session.id }, 200);
		}

		c.set("session", session);
		await next();
	},
	upgradeWebSocket((c) => {
		const session = c.get("session");
		const sessionId = session.id;

		return {
			onOpen(event, ws) {
				(ws as any).connectionId = crypto.randomUUID();
			},

			async onMessage(event, ws) {
				try {
					const data = JSON.parse(event.data.toString());

					if (data.type === "PONG") {
						const pid = data.participantId;
						if (!pid) return;

						const conn = wsByParticipant.get(pid);
						if (conn) {
							conn.missedPongs = 0;
							broadcastToPresenters(conn.sessionId, {
								type: "PLAYER_HEALTH_UPDATE",
								payload: { id: pid, failingHeartbeat: false }
							});
						}
						return;
					}

					if (data.type === "JOIN_NICKNAME") {
						const nickname = typeof data.nickname === "string" ? data.nickname.trim() : "";
						if (!nickname || nickname.length > 35) {
							ws.send(
								JSON.stringify({
									type: "ERROR",
									message: "Nickname must be between 1 and 35 characters."
								})
							);
							return;
						}

						const blockedSet = blockedNicknamesBySession.get(sessionId);
						if (blockedSet && blockedSet.has(nickname.toLowerCase())) {
							ws.send(
								JSON.stringify({
									type: "KICKED",
									message: "This nickname has been blocked by the host."
								})
							);
							ws.close(4001, "Blocked");
							return;
						}

						let participantId = data.participantId;
						let participant: any;

						if (participantId) {
							const [existingParticipant] = await database
								.select()
								.from(sessionParticipants)
								.where(eq(sessionParticipants.id, participantId))
								.limit(1);

							if (existingParticipant) {
								participant = existingParticipant;

								if (disconnectGracePeriods.has(participantId)) {
									clearTimeout(disconnectGracePeriods.get(participantId)!);
									disconnectGracePeriods.delete(participantId);
								}

								const oldConn = wsByParticipant.get(participantId);
								if (oldConn && oldConn.ws && oldConn.connectionId !== (ws as any).connectionId) {
									try {
										oldConn.ws.close(4000, "Superseded by new connection");
									} catch {}
								}
							}
						}

						if (!participant) {
							const existingParticipants = await database
								.select()
								.from(sessionParticipants)
								.where(eq(sessionParticipants.sessionId, sessionId));

							if (
								existingParticipants.some(
									(p) => p.nickname.toLowerCase() === nickname.toLowerCase()
								)
							) {
								ws.send(JSON.stringify({ type: "ERROR", message: "Nickname is already taken." }));
								return;
							}

							const [newParticipant] = await database
								.insert(sessionParticipants)
								.values({ sessionId, nickname, score: 0 })
								.returning();
							participant = newParticipant;
						}

						(ws as any).participantId = participant.id;
						(ws as any).sessionId = sessionId;

						wsByParticipant.set(participant.id, {
							ws,
							sessionId,
							participantId: participant.id,
							tickAge: 0,
							missedPongs: 0,
							connectionId: (ws as any).connectionId
						});

						broadcastToPresenters(sessionId, {
							type: "PLAYER_HEALTH_UPDATE",
							payload: { id: participant.id, failingHeartbeat: false }
						});

						ws.send(
							JSON.stringify({
								type: "JOINED_SUCCESS",
								payload: { id: participant.id, nickname: participant.nickname }
							})
						);
						broadcastToPresenters(sessionId, {
							type: "PLAYER_JOINED",
							payload: {
								id: participant.id,
								nickname: participant.nickname,
								failingHeartbeat: false
							}
						});
					}
				} catch (err) {
					console.error("[Quiz Player WS] Error handling message:", err);
				}
			},

			async onClose(event, ws) {
				const pid = (ws as any).participantId;
				const sid = (ws as any).sessionId || sessionId;
				const cid = (ws as any).connectionId;

				if (pid && cid) {
					const activeConn = wsByParticipant.get(pid);
					if (activeConn && activeConn.connectionId !== cid) {
						return;
					}

					if (event.code === 4000) return;

					if (event.code === 1000 || event.code === 4001) {
						await terminateParticipant(pid, sid);
						return;
					}

					handleSocketDisconnection(pid, sid, cid);
				}
			}
		};
	})
);
