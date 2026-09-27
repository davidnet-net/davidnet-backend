import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { database } from "../../core/database/client";
import {
	quizSessions,
	sessionParticipants,
	sessionResponses
} from "../../core/database/schema/quiz";
import { eq, sql } from "drizzle-orm";
import { broadcastToPresenters } from "./quiz_present";
import { sanitizeValue } from "../../middlewares/sanitizeUnicode";

type PlayerConnection = {
	ws: any;
	sessionId: string;
	participantId: string;
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
		disconnectGracePeriods: new Map<string, ReturnType<typeof setTimeout>>(),
		activeQuestionsBySession: new Map<string, any>()
	};
}
const state = (globalThis as any)[GLOBAL_STATE_KEY];

export const wsByParticipant = state.wsByParticipant;
export const blockedNicknamesBySession = state.blockedNicknamesBySession;
const disconnectGracePeriods = state.disconnectGracePeriods;

const HEARTBEAT_TICK_MS = 5000;
const FAILING_MISSED_TICKS = 3;
const DEAD_MISSED_TICKS = 6;

const GLOBAL_INTERVAL_KEY = "__quiz_heartbeat_interval__";
if ((globalThis as any)[GLOBAL_INTERVAL_KEY]) {
	clearInterval((globalThis as any)[GLOBAL_INTERVAL_KEY]);
}

(globalThis as any)[GLOBAL_INTERVAL_KEY] = setInterval(() => {
	const deadSockets: PlayerConnection[] = [];

	wsByParticipant.forEach((conn: PlayerConnection, participantId: string) => {
		try {
			if (!conn.ws || conn.ws.readyState !== 1) {
				deadSockets.push(conn);
				return;
			}
			conn.missedPongs += 1;
			if (conn.missedPongs >= DEAD_MISSED_TICKS) {
				deadSockets.push(conn);
			} else {
				if (conn.missedPongs >= FAILING_MISSED_TICKS) {
					broadcastToPresenters(conn.sessionId, {
						type: "PLAYER_HEALTH_UPDATE",
						payload: { id: participantId, failingHeartbeat: true }
					});
				}
				conn.ws.send(JSON.stringify({ type: "PING" }));
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

export function broadcastToSessionPlayers(sessionId: string, message: any) {
	const msgStr = JSON.stringify(message);
	wsByParticipant.forEach((conn: PlayerConnection) => {
		if (conn.sessionId === sessionId && conn.ws.readyState === 1) {
			conn.ws.send(msgStr);
		}
	});
}

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
	if (!blockedNicknamesBySession.has(sessionId))
		blockedNicknamesBySession.set(sessionId, new Set());
	blockedNicknamesBySession.get(sessionId)!.add(nickname.toLowerCase());
	const conn = wsByParticipant.get(playerId);
	if (conn && conn.ws && conn.ws.readyState === 1) {
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
	const timeout = setTimeout(async () => {
		disconnectGracePeriods.delete(participantId);
		const activeConn = wsByParticipant.get(participantId);
		if (!activeConn || activeConn.connectionId === connectionId) {
			await terminateParticipant(participantId, sessionId);
		}
	}, 15000);
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
		if (!pin || pin.length !== 6) return c.json({ error: "Invalid PIN format" }, 400);
		const [session] = await database
			.select()
			.from(quizSessions)
			.where(eq(quizSessions.pinCode, pin))
			.limit(1);
		if (!session) return c.json({ error: "Quiz not found or invalid PIN" }, 404);
		if (session.locked && !c.req.query("participantId"))
			return c.json({ error: "This quiz session is locked by the host." }, 403);
		if (session.status === "finished")
			return c.json({ error: "This quiz has already finished." }, 403);
		if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
			return c.json({ success: true, sessionId: session.id }, 200);

		c.set("session", session);
		await next();
	},
	upgradeWebSocket((c) => {
		const session = c.get("session");
		const sessionId = session.id;
		let connectionId = crypto.randomUUID();
		let participantId: string | null = null;

		return {
			async onMessage(event, ws) {
				try {
					const rawData = JSON.parse(event.data.toString());
					const data = sanitizeValue(rawData) as any;

					if (data.type === "PONG") {
						if (participantId) {
							const conn = wsByParticipant.get(participantId);
							if (conn && conn.connectionId === connectionId) {
								if (conn.missedPongs >= FAILING_MISSED_TICKS) {
									broadcastToPresenters(sessionId, {
										type: "PLAYER_HEALTH_UPDATE",
										payload: { id: participantId, failingHeartbeat: false }
									});
								}
								conn.missedPongs = 0;
							}
						}
						return;
					}

					if (data.type === "JOIN_NICKNAME") {
						const rawNickname = typeof data.nickname === "string" ? data.nickname.trim() : "";
						const nickname = (sanitizeValue(rawNickname) as string).trim();
						if (!nickname || nickname.length > 35) {
							ws.send(
								JSON.stringify({
									type: "ERROR",
									message: "Nickname must be between 1 and 35 characters."
								})
							);
							try {
								ws.close(4000);
							} catch {}
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
							try {
								ws.close(4001, "Blocked");
							} catch {}
							return;
						}

						let pId = data.participantId;
						let participant: any;

						if (pId) {
							const [existingParticipant] = await database
								.select()
								.from(sessionParticipants)
								.where(eq(sessionParticipants.id, pId))
								.limit(1);
							if (existingParticipant) {
								participant = existingParticipant;
								if (disconnectGracePeriods.has(pId)) {
									clearTimeout(disconnectGracePeriods.get(pId)!);
									disconnectGracePeriods.delete(pId);
								}
								const oldConn = wsByParticipant.get(pId);
								if (oldConn && oldConn.ws && oldConn.connectionId !== connectionId) {
									try {
										oldConn.ws.close(4000, "Superseded by new connection");
									} catch {}
								}
							} else if (!disconnectGracePeriods.has(pId)) {
								ws.send(
									JSON.stringify({ type: "KICKED", message: "You were removed from the session." })
								);
								try {
									ws.close(4001, "Removed");
								} catch {}
								return;
							}
						}

						if (!participant) {
							if (session.locked) {
								ws.send(JSON.stringify({ type: "ERROR", message: "Session is locked." }));
								try {
									ws.close(4000);
								} catch {}
								return;
							}
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

						participantId = participant.id;
						wsByParticipant.set(participantId, {
							ws,
							sessionId,
							participantId,
							missedPongs: 0,
							connectionId
						});

						broadcastToPresenters(sessionId, {
							type: "PLAYER_HEALTH_UPDATE",
							payload: { id: participantId, failingHeartbeat: false }
						});
						ws.send(
							JSON.stringify({
								type: "JOINED_SUCCESS",
								payload: { id: participantId, nickname: participant.nickname }
							})
						);
						broadcastToPresenters(sessionId, {
							type: "PLAYER_JOINED",
							payload: {
								id: participantId,
								nickname: participant.nickname,
								failingHeartbeat: false
							}
						});

						// RECONNECTION STATE SYNC
						const activeSession = state.activeQuestionsBySession.get(sessionId);
						if (activeSession) {
							const phase = activeSession.phase;
							const hasAnswered = activeSession.responses.has(participantId);
							if (phase === "preview" || phase === "active") {
								ws.send(
									JSON.stringify({
										type: phase === "preview" ? "QUESTION_PREVIEW" : "QUESTION_ACTIVE",
										serverTime: activeSession.serverTime,
										durationMs: activeSession.durationMs,
										payload: activeSession.playerPayload
									})
								);
								if (hasAnswered) {
									ws.send(JSON.stringify({ type: "ANSWER_ACK" }));
								}
							} else if (phase === "results") {
								const pResponse = activeSession.responses.get(participantId);
								ws.send(
									JSON.stringify({
										type: "RESULTS",
										payload: {
											correct: pResponse?.isCorrect || false,
											pointsEarned: pResponse?.pointsEarned || 0,
											correctOptions: activeSession.presenterPayload.options
												.filter((o: any) => o.isCorrect)
												.map((o: any) => o.id)
										}
									})
								);
							} else if (phase === "leaderboard") {
								ws.send(
									JSON.stringify({ type: "LEADERBOARD", payload: activeSession.leaderboard })
								);
							} else if (phase === "finished") {
								ws.send(JSON.stringify({ type: "FINISHED", payload: activeSession.leaderboard }));
							}
						}
					}

					// HANDLE ANSWER SUBMISSION
					if (data.type === "SUBMIT_ANSWER" && participantId) {
						const activeSession = state.activeQuestionsBySession.get(sessionId);
						if (!activeSession || activeSession.phase !== "active") return;
						if (activeSession.responses.has(participantId)) return; // Prevent double answering

						const qId = activeSession.presenterPayload.question.id;
						const timeLimitMs = activeSession.durationMs;
						const multiplier = activeSession.presenterPayload.question.pointsMultiplier || 1;
						let responseTimeMs = Date.now() - activeSession.serverTime;
						if (responseTimeMs < 0) responseTimeMs = 0;

						// Grace period allowed (1.5 seconds)
						if (responseTimeMs > timeLimitMs + 1500) return;

						let submittedIds = Array.isArray(data.optionIds) ? data.optionIds : [];
						const correctOptions = activeSession.presenterPayload.options
							.filter((o: any) => o.isCorrect)
							.map((o: any) => o.id);

						// Exact match required for multi-select and standard
						const isCorrect =
							submittedIds.length === correctOptions.length &&
							submittedIds.every((id: string) => correctOptions.includes(id));

						// Kahoot Points Formula
						let pointsEarned = 0;
						if (isCorrect) {
							const clampRatio = Math.min(Math.max(responseTimeMs / timeLimitMs, 0), 1);
							pointsEarned = Math.round((1 - clampRatio / 2) * 1000 * multiplier);
						}

						activeSession.responses.set(participantId, {
							isCorrect,
							pointsEarned,
							selectedOptionIds: submittedIds
						});

						// Fire and forget DB insertion
						database
							.insert(sessionResponses)
							.values({
								sessionId,
								questionId: qId,
								participantId: participantId,
								selectedOptionId: submittedIds[0] || null,
								answerTimeMs: responseTimeMs,
								pointsEarned: pointsEarned
							})
							.execute();

						if (pointsEarned > 0) {
							database
								.update(sessionParticipants)
								.set({ score: sql`${sessionParticipants.score} + ${pointsEarned}` })
								.where(eq(sessionParticipants.id, participantId))
								.execute();
						}

						// Acknowledge submission to player
						ws.send(JSON.stringify({ type: "ANSWER_ACK" }));

						// Check Auto-skip if all players answered
						const playersInSession = Array.from(wsByParticipant.values()).filter(
							(p: any) => p.sessionId === sessionId
						);
						if (
							activeSession.responses.size >= playersInSession.length &&
							playersInSession.length > 0
						) {
							activeSession.phase = "results";
							const breakdown: Record<string, number> = {};
							activeSession.responses.forEach((res: any) => {
								res.selectedOptionIds.forEach((id: string) => {
									breakdown[id] = (breakdown[id] || 0) + 1;
								});
							});
							activeSession.resultsBreakdown = breakdown;

							broadcastToPresenters(sessionId, {
								type: "RESULTS",
								breakdown,
								payload: activeSession.presenterPayload
							});

							const correctOptionIds = activeSession.presenterPayload.options
								.filter((o: any) => o.isCorrect)
								.map((o: any) => o.id);

							wsByParticipant.forEach((conn: PlayerConnection, pId: string) => {
								if (conn.sessionId === sessionId && conn.ws.readyState === 1) {
									const pResponse = activeSession.responses.get(pId);
									conn.ws.send(
										JSON.stringify({
											type: "RESULTS",
											payload: {
												correct: pResponse?.isCorrect || false,
												pointsEarned: pResponse?.pointsEarned || 0,
												correctOptions: correctOptionIds
											}
										})
									);
								}
							});
						} else {
							// Update presenter response count
							broadcastToPresenters(sessionId, {
								type: "RESPONSES_UPDATE",
								count: activeSession.responses.size
							});
						}
					}
				} catch (err) {
					console.error("[Quiz Player WS] Error handling message:", err);
				}
			},

			async onClose(event, ws) {
				if (participantId) {
					const activeConn = wsByParticipant.get(participantId);
					if (activeConn && activeConn.connectionId !== connectionId) return;
					if (event.code === 4000) return;
					if (event.code === 1000 || event.code === 4001) {
						await terminateParticipant(participantId, sessionId);
						return;
					}
					handleSocketDisconnection(participantId, sessionId, connectionId);
				}
			}
		};
	})
);
