// src/websockets/quiz_present.ts
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
import { kickParticipant, wsByParticipant, terminateSessionPlayers } from "./quiz_play";

type PresenterConnection = {
	ws: any;
	sessionId: string;
	missedPongs: number;
	connectionId: string;
};

export const activePresenters = new Map<string, Set<PresenterConnection>>();
const hostDisconnectGracePeriods = new Map<string, ReturnType<typeof setTimeout>>();

const HOST_HEARTBEAT_TICK_MS = 5000;
const HOST_DEAD_MISSED_TICKS = 12; // Allow up to 12 misses (60 seconds)

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
			conn.ws.send(JSON.stringify({ type: "PING" }));
			conn.missedPongs++;

			if (conn.missedPongs >= HOST_DEAD_MISSED_TICKS) {
				deadConns.add(conn);
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
			}, 15000); // 15 seconds grace period for the host to reload the tab
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
		const token = getCookie(c, "access_token");

		const authResult = await checkAuth(token);
		if (!authResult) return c.text("Unauthorized", 401);

		const [quiz] = await database
			.select({ id: quizzes.id, teamId: quizzes.teamId, workspaceId: quizzes.workspaceId })
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

		if (!hasAccess) return c.json({ error: "Forbidden: Missing presentation permission" }, 403);

		const quizQuestions = await database
			.select()
			.from(questions)
			.where(eq(questions.quizId, quizId));

		if (quizQuestions.length === 0) {
			return c.json({ error: "Cannot present a quiz with no questions." }, 400);
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
				return c.json(
					{ error: `Question ${q.position + 1} is invalid. Please fix it before presenting.` },
					400
				);
			}
		}

		await database
			.delete(quizSessions)
			.where(and(eq(quizSessions.quizId, quizId), eq(quizSessions.status, "lobby")));

		const pinCode = await generateUniquePin();
		const [session] = await database
			.insert(quizSessions)
			.values({
				quizId,
				pinCode,
				status: "lobby",
				locked: false
			})
			.returning();

		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			return c.json({ success: true, sessionId: session.id, pinCode: session.pinCode }, 200);
		}

		c.set("session", session);
		await next();
	},
	upgradeWebSocket((c) => {
		const session = c.get("session");
		const sessionId = session.id;

		return {
			async onOpen(event, ws) {
				if (!activePresenters.has(sessionId)) {
					activePresenters.set(sessionId, new Set());
				}

				const connectionId = crypto.randomUUID();
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
					const data = JSON.parse(event.data.toString());

					if (data.type === "PONG") {
						const cid = data.connectionId;
						if (!cid) return;

						const presenters = activePresenters.get(sessionId);
						if (presenters) {
							for (const conn of presenters) {
								if (conn.connectionId === cid) {
									conn.missedPongs = 0;
									break;
								}
							}
						}
						return;
					}

					if (data.type === "STOP_SESSION") {
						await terminateSessionPlayers(sessionId, "The host stopped the presentation.");
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
								locked: isLocked
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
				activePresenters.forEach((presenters, sid) => {
					for (const conn of presenters) {
						if (conn.ws === ws || conn.ws.raw === ws || (ws as any).raw === conn.ws) {
							presenters.delete(conn);

							if (presenters.size === 0 && !hostDisconnectGracePeriods.has(sid)) {
								const timeout = setTimeout(() => {
									hostDisconnectGracePeriods.delete(sid);
									const currentHosts = activePresenters.get(sid);
									if (!currentHosts || currentHosts.size === 0) {
										terminateSessionPlayers(sid, "The host disconnected. Presentation ended.");
										activePresenters.delete(sid);
									}
								}, 15000);
								hostDisconnectGracePeriods.set(sid, timeout);
							}
						}
					}
				});
			}
		};
	})
);
