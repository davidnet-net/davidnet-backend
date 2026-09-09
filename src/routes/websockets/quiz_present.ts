import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { database } from "../../core/database/client";
import {
	quizzes,
	quizCollaborators,
	quizSessions,
	questions,
	quizOptions,
	sessionParticipants,
	type QuizSession
} from "../../core/database/schema/quiz";
import { eq, and, inArray } from "drizzle-orm";
import { hasPermission } from "../../core/shared/checkPermissions";
import { verify } from "hono/jwt";
import { getCookie } from "hono/cookie";
import {
	kickParticipant,
	broadcastToSessionPlayers,
	terminateSessionPlayers,
	wsByParticipant
} from "./quiz_play";
import { sanitizeValue } from "../../middlewares/sanitizeUnicode";

type PresenterConnection = {
	ws: any;
	sessionId: string;
	missedPongs: number;
	connectionId: string;
};

export const activePresenters = new Map<string, Set<PresenterConnection>>();
const hostDisconnectGracePeriods = new Map<string, ReturnType<typeof setTimeout>>();

const HOST_HEARTBEAT_TICK_MS = 5000;
const HOST_DEAD_MISSED_TICKS = 12;

const GLOBAL_HOST_INTERVAL_KEY = "__quiz_host_heartbeat_interval__";
if ((globalThis as any)[GLOBAL_HOST_INTERVAL_KEY]) {
	clearInterval((globalThis as any)[GLOBAL_HOST_INTERVAL_KEY]);
}

(globalThis as any)[GLOBAL_HOST_INTERVAL_KEY] = setInterval(() => {
	activePresenters.forEach((presenters, sessionId) => {
		const deadConns = new Set<PresenterConnection>();

		for (const conn of presenters) {
			if (!conn.ws || conn.ws.readyState !== 1) {
				deadConns.add(conn);
				continue;
			}

			conn.missedPongs++;

			if (conn.missedPongs >= HOST_DEAD_MISSED_TICKS) {
				deadConns.add(conn);
			} else {
				conn.ws.send(JSON.stringify({ type: "PING" }));
			}
		}

		for (const conn of deadConns) {
			try {
				conn.ws.close(4008, "Host Heartbeat Timeout");
			} catch {}
			presenters.delete(conn);
		}

		if (presenters.size === 0 && !hostDisconnectGracePeriods.has(sessionId)) {
			const timeout = setTimeout(() => {
				hostDisconnectGracePeriods.delete(sessionId);
				const currentHosts = activePresenters.get(sessionId);
				if (!currentHosts || currentHosts.size === 0) {
					terminateSessionPlayers(sessionId, "The host disconnected. Presentation ended.");
					activePresenters.delete(sessionId);
				}
			}, 15000);
			hostDisconnectGracePeriods.set(sessionId, timeout);
		}
	});
}, HOST_HEARTBEAT_TICK_MS);

export function broadcastToPresenters(sessionId: string, message: any) {
	const presenters = activePresenters.get(sessionId);
	if (!presenters) return;
	const msgStr = JSON.stringify(message);
	for (const conn of presenters) {
		if (conn.ws.readyState === 1) conn.ws.send(msgStr);
	}
}

export const presentWs = new Hono<{
	Variables: {
		session: QuizSession;
		quizName: string;
	};
}>();

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

async function generateUniquePin(): Promise<string> {
	let pin = "";
	let isUnique = false;
	while (!isUnique) {
		pin = Math.floor(100000 + Math.random() * 900000).toString();
		const [existing] = await database
			.select({ id: quizSessions.id })
			.from(quizSessions)
			.where(eq(quizSessions.pinCode, pin))
			.limit(1);
		if (!existing) isUnique = true;
	}
	return pin;
}

function isQuestionInvalid(q: any, options: any[]): boolean {
	const SUPPORTED_TYPES = ["quiz", "true_false"];

	if (!q.type || !SUPPORTED_TYPES.includes(q.type)) return true;

	const questionText = q.text?.trim() || "";
	if (!questionText || questionText.length > 250) return true;

	if (q.type === "true_false") {
		const correctCount = options.filter((opt) => opt.isCorrect).length;
		return options.length !== 2 || correctCount !== 1;
	}

	if (q.type === "quiz") {
		const filledOptions = options.filter((opt) => {
			const text = opt.text?.trim() || "";
			return text.length > 0;
		});

		if (filledOptions.length < 2) return true;
		if (filledOptions.some((opt) => opt.text.trim().length > 100)) return true;

		const correctCount = filledOptions.filter((opt) => opt.isCorrect).length;

		if (!q.isMultiSelect && correctCount !== 1) return true;
		if (q.isMultiSelect && correctCount < 2) return true;
	}

	return false;
}

presentWs.get(
	"/:quizId",
	async (c, next) => {
		const quizId = c.req.param("quizId");
		const reqSessionId = c.req.query("sessionId");
		const token = getCookie(c, "access_token");

		const authResult = await checkAuth(token);
		if (!authResult) return c.text("Unauthorized", 401);

		const [quiz] = await database
			.select({
				id: quizzes.id,
				name: quizzes.name,
				teamId: quizzes.teamId,
				workspaceId: quizzes.workspaceId
			})
			.from(quizzes)
			.where(eq(quizzes.id, quizId))
			.limit(1);

		if (!quiz) return c.text("Quiz not found", 404);

		let hasAccess = false;
		const [collaborator] = await database
			.select({ id: quizCollaborators.id })
			.from(quizCollaborators)
			.where(
				and(
					eq(quizCollaborators.quizId, quizId),
					eq(quizCollaborators.userId, authResult.userID),
					eq(quizCollaborators.status, "accepted")
				)
			)
			.limit(1);

		if (collaborator) hasAccess = true;

		if (!hasAccess) {
			hasAccess = await hasPermission({
				userId: authResult.userID,
				workspaceId: quiz.workspaceId,
				teamId: quiz.teamId ?? undefined,
				permissionKey: "quiz:present"
			});
		}

		if (!hasAccess) return c.json({ code: "NO_PERMS" }, 403);

		const quizQuestions = await database
			.select()
			.from(questions)
			.where(eq(questions.quizId, quizId));

		if (quizQuestions.length === 0) {
			return c.json({ code: "NO_QUESTIONS" }, 400);
		}

		const quizOpts = await database
			.select()
			.from(quizOptions)
			.where(
				inArray(
					quizOptions.questionId,
					quizQuestions.map((q) => q.id)
				)
			);

		const optionsByQuestion = new Map<string, any[]>();
		quizOpts.forEach((opt) => {
			if (!optionsByQuestion.has(opt.questionId)) {
				optionsByQuestion.set(opt.questionId, []);
			}
			optionsByQuestion.get(opt.questionId)!.push(opt);
		});

		for (const q of quizQuestions) {
			const opts = optionsByQuestion.get(q.id) || [];
			if (isQuestionInvalid(q, opts)) {
				return c.json({ code: `QUESTION_INVALID` }, 400);
			}
		}

		let session: QuizSession | undefined;

		if (reqSessionId) {
			const [existingById] = await database
				.select()
				.from(quizSessions)
				.where(and(eq(quizSessions.id, reqSessionId), eq(quizSessions.quizId, quizId)))
				.limit(1);
			if (existingById) session = existingById;
		}

		if (!session) {
			const [existingLobby] = await database
				.select()
				.from(quizSessions)
				.where(and(eq(quizSessions.quizId, quizId), eq(quizSessions.status, "lobby")))
				.limit(1);
			if (existingLobby) session = existingLobby;
		}

		if (!session) {
			const pinCode = await generateUniquePin();
			const [newSession] = await database
				.insert(quizSessions)
				.values({
					quizId,
					pinCode,
					status: "lobby",
					locked: false
				})
				.returning();
			session = newSession;
		}

		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			return c.json(
				{ success: true, sessionId: session.id, pinCode: session.pinCode, quizName: quiz.name },
				200
			);
		}

		c.set("session", session);
		c.set("quizName", quiz.name);
		await next();
	},
	upgradeWebSocket((c) => {
		const session = c.get("session");
		const quizName = c.get("quizName");
		const sessionId = session.id;

		let connectionId = crypto.randomUUID();

		return {
			async onOpen(event, ws) {
				if (!activePresenters.has(sessionId)) {
					activePresenters.set(sessionId, new Set());
				}

				const presenterConn: PresenterConnection = {
					ws,
					sessionId,
					missedPongs: 0,
					connectionId
				};

				activePresenters.get(sessionId)!.add(presenterConn);

				if (hostDisconnectGracePeriods.has(sessionId)) {
					clearTimeout(hostDisconnectGracePeriods.get(sessionId)!);
					hostDisconnectGracePeriods.delete(sessionId);
				}

				const currentParticipants = await database
					.select()
					.from(sessionParticipants)
					.where(eq(sessionParticipants.sessionId, sessionId));

				ws.send(
					JSON.stringify({
						type: "SESSION_INFO",
						payload: {
							sessionId: session.id,
							pinCode: session.pinCode,
							locked: session.locked,
							quizName,
							connectionId,
							players: currentParticipants.map((p) => {
								const playerConn = wsByParticipant.get(p.id);
								const missed = playerConn?.missedPongs || 0;
								return {
									id: p.id,
									nickname: p.nickname,
									failingHeartbeat: missed >= 3
								};
							})
						}
					})
				);
			},

			async onMessage(event, ws) {
				try {
					const rawData = JSON.parse(event.data.toString());
					const data = sanitizeValue(rawData) as any;

					if (data.type === "PONG") {
						const presenters = activePresenters.get(sessionId);
						if (presenters) {
							for (const conn of presenters) {
								if (conn.connectionId === connectionId) {
									conn.missedPongs = 0;
									break;
								}
							}
						}
						return;
					}

					if (data.type === "START_SESSION") {
						await database
							.update(quizSessions)
							.set({ status: "question_active", currentQuestionIndex: 0 })
							.where(eq(quizSessions.id, sessionId));

						const quizQuestions = await database
							.select()
							.from(questions)
							.where(eq(questions.quizId, session.quizId))
							.orderBy(questions.position);

						const firstQ = quizQuestions[0];
						if (!firstQ) return;

						const qOptions = await database
							.select()
							.from(quizOptions)
							.where(eq(quizOptions.questionId, firstQ.id))
							.orderBy(quizOptions.position);

						// Save standard UI slot colors before shuffling options
						const slotColors = qOptions.map((o) => o.color);

						// Fisher-Yates Shuffle
						const shuffledOptions = [...qOptions];
						for (let i = shuffledOptions.length - 1; i > 0; i--) {
							const j = Math.floor(Math.random() * (i + 1));
							[shuffledOptions[i], shuffledOptions[j]] = [shuffledOptions[j], shuffledOptions[i]];
						}

						// Re-assign colors to slots so UI option colors DO NOT move
						shuffledOptions.forEach((opt, idx) => {
							opt.color = slotColors[idx] ?? opt.color;
						});

						const presenterPayload = { question: firstQ, options: shuffledOptions };
						const playerOptions = shuffledOptions.map((o) => ({
							id: o.id,
							text: o.text,
							color: o.color,
							position: o.position
						}));

						const playerPayload = {
							question: {
								id: firstQ.id,
								text: firstQ.text,
								type: firstQ.type,
								timeLimit: firstQ.timeLimit,
								isMultiSelect: firstQ.isMultiSelect
							},
							options: playerOptions
						};

						const previewDurationMs = 5000;
						const previewServerTime = Date.now();

						const globalPlayState = (globalThis as any)["__quiz_play_state__"];
						if (globalPlayState?.activeQuestionsBySession) {
							globalPlayState.activeQuestionsBySession.set(sessionId, {
								type: "QUESTION_PREVIEW",
								serverTime: previewServerTime,
								durationMs: previewDurationMs,
								payload: playerPayload
							});
						}

						broadcastToPresenters(sessionId, {
							type: "QUESTION_PREVIEW",
							serverTime: previewServerTime,
							durationMs: previewDurationMs,
							payload: presenterPayload
						});

						broadcastToSessionPlayers(sessionId, {
							type: "QUESTION_PREVIEW",
							serverTime: previewServerTime,
							durationMs: previewDurationMs,
							payload: playerPayload
						});

						setTimeout(() => {
							const activeServerTime = Date.now();
							const activeDurationMs = firstQ.timeLimit * 1000;

							if (globalPlayState?.activeQuestionsBySession) {
								globalPlayState.activeQuestionsBySession.set(sessionId, {
									type: "QUESTION_ACTIVE",
									serverTime: activeServerTime,
									durationMs: activeDurationMs,
									payload: playerPayload
								});
							}

							broadcastToPresenters(sessionId, {
								type: "QUESTION_ACTIVE",
								serverTime: activeServerTime,
								durationMs: activeDurationMs,
								payload: presenterPayload
							});

							broadcastToSessionPlayers(sessionId, {
								type: "QUESTION_ACTIVE",
								serverTime: activeServerTime,
								durationMs: activeDurationMs,
								payload: playerPayload
							});
						}, previewDurationMs);

						return;
					}

					if (data.type === "STOP_SESSION") {
						await terminateSessionPlayers(sessionId, "The host stopped the presentation.");
						await database.delete(quizSessions).where(eq(quizSessions.id, sessionId));
						activePresenters.delete(sessionId);
						return;
					}

					if (data.type === "LOCK_SESSION" || data.type === "UNLOCK_SESSION") {
						const isLocked = data.type === "LOCK_SESSION";

						await database
							.update(quizSessions)
							.set({ locked: isLocked })
							.where(eq(quizSessions.id, sessionId));

						broadcastToPresenters(sessionId, {
							type: "SESSION_INFO",
							payload: {
								sessionId: session.id,
								pinCode: session.pinCode,
								locked: isLocked,
								quizName
							}
						});
					} else if (data.type === "REMOVE_PLAYER") {
						const playerId = data.payload?.playerId;
						if (playerId) {
							const [participant] = await database
								.select()
								.from(sessionParticipants)
								.where(eq(sessionParticipants.id, playerId))
								.limit(1);

							if (participant) {
								await kickParticipant(playerId, sessionId, participant.nickname);
							}
						}
					}
				} catch (error) {
					console.error("[Quiz Presenter WS] Failed to parse message:", error);
				}
			},

			onClose(event, ws) {
				const presenters = activePresenters.get(sessionId);
				if (presenters) {
					for (const conn of presenters) {
						if (conn.connectionId === connectionId) {
							presenters.delete(conn);

							if (presenters.size === 0 && !hostDisconnectGracePeriods.has(sessionId)) {
								const timeout = setTimeout(() => {
									hostDisconnectGracePeriods.delete(sessionId);
									const currentHosts = activePresenters.get(sessionId);
									if (!currentHosts || currentHosts.size === 0) {
										terminateSessionPlayers(
											sessionId,
											"The host disconnected. Presentation ended."
										);
										activePresenters.delete(sessionId);
									}
								}, 15000);
								hostDisconnectGracePeriods.set(sessionId, timeout);
							}
							break;
						}
					}
				}
			}
		};
	})
);
