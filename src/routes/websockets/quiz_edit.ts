import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import * as Y from "yjs";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates
} from "y-protocols/awareness";
import { database } from "../../core/database/client";
import {
	quizzes,
	quizCollaborators,
	questions,
	quizOptions,
	type NewQuestion,
	type NewQuizOption
} from "../../core/database/schema/quiz";
import { eq, and } from "drizzle-orm";
import { hasPermission } from "../../core/shared/checkPermissions";
import { verify } from "hono/jwt";
import { getCookie } from "hono/cookie";

const quizRooms = new Map<string, Y.Doc>();
const roomClients = new Map<string, Set<any>>();
const saveTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const lastSaved = new Map<string, number>();

const roomAwareness = new Map<string, Awareness>();
const clientIDsByWs = new WeakMap<any, Set<number>>();
const wsCanManage = new WeakMap<any, boolean>();
const wsIsAlive = new WeakMap<any, boolean>();

export const editWs = new Hono<{
	Variables: {
		canManage: boolean;
	};
}>();

setInterval(() => {
	roomClients.forEach((clients) => {
		for (const ws of clients) {
			if (wsIsAlive.get(ws) === false) {
				ws.close(1000, "Heartbeat Timeout");
			} else {
				wsIsAlive.set(ws, false);
				ws.send(new Uint8Array([2]).buffer);
			}
		}
	});
}, 30000);

async function checkAuth(token: string | undefined) {
	if (!token) return false;
	const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
	if (!ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is not configured");

	try {
		const payload = await verify(token, ACCESS_SECRET, "HS256");
		if (payload.type && payload.type !== "access") return false;

		const userID = payload.userID as string;
		if (!userID) return false;
		return { userID, jwtID: payload.jwtID as string };
	} catch {
		return false;
	}
}

// Checkt en handhaaft hard de 500-karakter limiet in het YJS document
function enforceTextLimits(doc: Y.Doc) {
	doc.transact(() => {
		const quizMeta = doc.getMap<string>("quizMeta");
		const name = quizMeta.get("name");
		if (typeof name === "string" && name.length > 500) {
			quizMeta.set("name", name.substring(0, 500));
		}

		const questionsList = doc.getArray<Y.Map<any>>("questions");
		questionsList.forEach((q) => {
			if (q instanceof Y.Map) {
				const text = q.get("text");
				if (typeof text === "string" && text.length > 500) {
					q.set("text", text.substring(0, 500));
				}

				const options = q.get("options");
				if (Array.isArray(options)) {
					let changed = false;
					const newOptions = options.map((opt: any) => {
						if (
							opt !== null &&
							typeof opt === "object" &&
							typeof opt.text === "string" &&
							opt.text.length > 500
						) {
							changed = true;
							return { ...opt, text: opt.text.substring(0, 500) };
						}
						return opt;
					});
					if (changed) {
						q.set("options", newOptions);
					}
				} else if (options instanceof Y.Array) {
					options.forEach((opt: any) => {
						if (opt instanceof Y.Map) {
							const optText = opt.get("text");
							if (typeof optText === "string" && optText.length > 500) {
								opt.set("text", optText.substring(0, 500));
							}
						}
					});
				}
			}
		});
	}, "server"); // De 'origin' wordt op 'server' gezet zodat we dit kunnen herkennen
}

async function persistQuizToDatabase(quizId: string, doc: Y.Doc) {
	try {
		const stateVector = Y.encodeStateAsUpdate(doc);
		const base64State = Buffer.from(stateVector).toString("base64");
		const quizMeta = doc.getMap<string>("quizMeta");

		const rawQuizName = quizMeta.get("name");
		const safeQuizName =
			typeof rawQuizName === "string" && rawQuizName.trim().length > 0
				? rawQuizName.trim().substring(0, 500)
				: null;

		const questionsArray = doc
			.getArray<Y.Map<any>>("questions")
			.toArray()
			.map((q) => q.toJSON());

		const VALID_TYPES = new Set([
			"quiz",
			"true_false",
			"slider",
			"puzzle",
			"type_answer",
			"poll",
			"word_cloud",
			"scale",
			"information"
		]);
		const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

		await database.transaction(async (tx) => {
			const updatePayload: any = {
				state: base64State,
				updatedAt: new Date()
			};
			if (safeQuizName !== null) {
				updatePayload.name = safeQuizName;
			}

			await tx.update(quizzes).set(updatePayload).where(eq(quizzes.id, quizId));
			await tx.delete(questions).where(eq(questions.quizId, quizId));

			if (questionsArray.length > 0) {
				const questionsToInsert: NewQuestion[] = [];
				const optionsToInsert: NewQuizOption[] = [];

				questionsArray.forEach((q, index) => {
					const rawId = q.id;
					if (!rawId || typeof rawId !== "string" || !UUID_REGEX.test(rawId)) return;

					let safeType = typeof q.type === "string" ? q.type : "quiz";
					if (safeType === "Multiple choice") safeType = "quiz";
					if (!VALID_TYPES.has(safeType)) safeType = "quiz";

					const safeText = typeof q.text === "string" ? q.text.trim().substring(0, 500) : "";
					const safeTimeLimit =
						typeof q.timeLimit === "number" && !isNaN(q.timeLimit)
							? Math.max(5, Math.min(q.timeLimit, 3600))
							: 20;
					const safeMultiplier =
						typeof q.pointsMultiplier === "number" && !isNaN(q.pointsMultiplier)
							? Math.max(0, Math.min(q.pointsMultiplier, 10))
							: 1;
					const safeIsMultiSelect = typeof q.isMultiSelect === "boolean" ? q.isMultiSelect : false;

					questionsToInsert.push({
						id: rawId,
						quizId: quizId,
						text: safeText,
						type: safeType as NewQuestion["type"],
						position: index,
						timeLimit: safeTimeLimit,
						pointsMultiplier: safeMultiplier,
						isMultiSelect: safeIsMultiSelect
					});

					if (Array.isArray(q.options)) {
						q.options.forEach((opt: any, optIndex: number) => {
							const optText = typeof opt.text === "string" ? opt.text.trim().substring(0, 500) : "";
							optionsToInsert.push({
								id: opt.id && UUID_REGEX.test(opt.id) ? opt.id : crypto.randomUUID(),
								questionId: rawId,
								text: optText,
								isCorrect: !!opt.isCorrect,
								color: typeof opt.color === "string" ? opt.color : "red",
								position: optIndex
							});
						});
					}
				});

				if (questionsToInsert.length > 0) {
					await tx.insert(questions).values(questionsToInsert);
				}
				if (optionsToInsert.length > 0) {
					await tx.insert(quizOptions).values(optionsToInsert);
				}
			}
		});
	} catch (error) {
		console.error(`[Quiz DB] Failed to persist quiz ${quizId}:`, error);
	}
}

function scheduleSave(quizId: string, doc: Y.Doc) {
	const now = Date.now();
	const last = lastSaved.get(quizId) || now;

	if (saveTimeouts.has(quizId)) clearTimeout(saveTimeouts.get(quizId)!);

	if (now - last > 30000) {
		persistQuizToDatabase(quizId, doc);
		lastSaved.set(quizId, now);
		return;
	}

	const timeout = setTimeout(() => {
		persistQuizToDatabase(quizId, doc);
		lastSaved.set(quizId, Date.now());
		saveTimeouts.delete(quizId);
	}, 3000);

	saveTimeouts.set(quizId, timeout);
}

editWs.get(
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
		let canManage = false;

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

		if (collaborator) {
			hasAccess = true;
		}

		const hasWorkspaceEdit = await hasPermission({
			userId: authResult.userID,
			workspaceId: quiz.workspaceId,
			teamId: quiz.teamId ?? undefined,
			permissionKey: "quiz:edit"
		});

		if (hasWorkspaceEdit) {
			hasAccess = true;
		}

		canManage = await hasPermission({
			userId: authResult.userID,
			workspaceId: quiz.workspaceId,
			teamId: quiz.teamId ?? undefined,
			permissionKey: "quiz:manage"
		});

		if (!hasAccess) {
			return c.json({ error: "Forbidden: Missing required permission" }, 403);
		}

		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			return c.json({ success: true }, 200);
		}

		c.set("canManage", canManage);

		await next();
	},
	upgradeWebSocket((c) => {
		const quizId = c.req.param("quizId");
		const canManage = c.get("canManage") ?? false;

		return {
			async onOpen(event, ws) {
				if (!quizId) {
					ws.close(400, "Missing quizID");
					return;
				}

				wsIsAlive.set(ws, true);
				wsCanManage.set(ws, canManage);

				if (!roomClients.has(quizId)) roomClients.set(quizId, new Set());
				roomClients.get(quizId)?.add(ws);

				let doc = quizRooms.get(quizId);
				let awareness = roomAwareness.get(quizId);

				if (!doc) {
					doc = new Y.Doc();

					// Belangrijk: Zend acties en correcties van de server door naar alle verbonden clients
					doc.on("update", (update: Uint8Array, origin: any) => {
						if (origin === "server") {
							const updateMessage = new Uint8Array(1 + update.length);
							updateMessage[0] = 0;
							updateMessage.set(update, 1);

							const clients = roomClients.get(quizId);
							if (clients) {
								for (const client of clients) {
									client.send(updateMessage.buffer);
								}
							}
						}
					});

					const [quizRecord] = await database
						.select({
							state: quizzes.state,
							name: quizzes.name,
							teamId: quizzes.teamId,
							workspaceId: quizzes.workspaceId
						})
						.from(quizzes)
						.where(eq(quizzes.id, quizId))
						.limit(1);

					if (quizRecord?.state) {
						const binaryUpdate = new Uint8Array(Buffer.from(quizRecord.state, "base64"));
						Y.applyUpdate(doc, binaryUpdate);
					}

					const quizMeta = doc.getMap<string>("quizMeta");
					if (!quizMeta.get("name") && quizRecord?.name) {
						quizMeta.set("name", quizRecord.name);
					}
					if (!quizMeta.get("teamId") && quizRecord?.teamId) {
						quizMeta.set("teamId", quizRecord.teamId);
					}
					if (!quizMeta.get("workspaceId") && quizRecord?.workspaceId) {
						quizMeta.set("workspaceId", quizRecord.workspaceId);
					}
					quizRooms.set(quizId, doc);
				}

				if (!awareness) {
					awareness = new Awareness(doc);
					roomAwareness.set(quizId, awareness);

					awareness.on("update", ({ added, updated, removed }: any, origin: any) => {
						if (origin && typeof origin === "object") {
							let ids = clientIDsByWs.get(origin);
							if (!ids) {
								ids = new Set();
								clientIDsByWs.set(origin, ids);
							}
							added.forEach((id: number) => ids!.add(id));
							updated.forEach((id: number) => ids!.add(id));
						}

						if (origin === "server") {
							const clients = roomClients.get(quizId);
							if (clients) {
								const changedClients = [...added, ...updated, ...removed];
								if (changedClients.length > 0) {
									const awarenessUpdate = encodeAwarenessUpdate(awareness!, changedClients);
									const message = new Uint8Array(1 + awarenessUpdate.length);
									message[0] = 1;
									message.set(awarenessUpdate, 1);

									for (const client of clients) {
										client.send(message.buffer);
									}
								}
							}
						}
					});
				}

				const docState = Y.encodeStateAsUpdate(doc);
				const docMessage = new Uint8Array(1 + docState.length);
				docMessage[0] = 0;
				docMessage.set(docState, 1);
				ws.send(docMessage.buffer);

				const awarenessStates = Array.from(awareness.getStates().keys());
				if (awarenessStates.length > 0) {
					const awarenessState = encodeAwarenessUpdate(awareness, awarenessStates);
					const awarenessMessage = new Uint8Array(1 + awarenessState.length);
					awarenessMessage[0] = 1;
					awarenessMessage.set(awarenessState, 1);
					ws.send(awarenessMessage.buffer);
				}
			},

			onMessage(event, ws) {
				if (!quizId) return;
				const doc = quizRooms.get(quizId);
				if (!doc) return;

				const data = new Uint8Array(event.data as ArrayBuffer);
				if (data.length === 0) return;

				const messageType = data[0];

				if (messageType === 3) {
					wsIsAlive.set(ws, true);
					return;
				}

				const payload = data.subarray(1);

				if (messageType === 0) {
					const userCanManage = wsCanManage.get(ws) ?? false;
					let quizMetaSnapshot: Map<string, any> | null = null;
					const quizMeta = doc.getMap<string>("quizMeta");

					if (!userCanManage) {
						quizMetaSnapshot = new Map(quizMeta.entries());
					}

					Y.applyUpdate(doc, payload, ws);

					// Eerst de binnengekomen wijziging direct doorsturen
					const clients = roomClients.get(quizId);
					if (clients) {
						for (const client of clients) {
							if (client !== ws) client.send(data);
						}
					}

					// Controleer op niet-toegestane bewerkingen door clients zonder permissies
					if (!userCanManage && quizMetaSnapshot) {
						let mutated = false;
						quizMeta.forEach((val, key) => {
							if (quizMetaSnapshot!.get(key) !== val) {
								mutated = true;
							}
						});
						quizMetaSnapshot.forEach((val, key) => {
							if (quizMeta.get(key) !== val) {
								mutated = true;
							}
						});

						if (mutated) {
							// De 'server' origin zorgt dat alle clients hiervan een update krijgen in de doc.on("update") event listener
							doc.transact(() => {
								quizMetaSnapshot!.forEach((val, key) => {
									quizMeta.set(key, val);
								});
							}, "server");
						}
					}

					// Forceer 500-karakters harde limieten voor alle string fields
					enforceTextLimits(doc);

					scheduleSave(quizId, doc);
				} else if (messageType === 1) {
					const awareness = roomAwareness.get(quizId);
					if (awareness) {
						applyAwarenessUpdate(awareness, payload, ws);
					}

					const clients = roomClients.get(quizId);
					if (clients) {
						for (const client of clients) {
							if (client !== ws) client.send(data);
						}
					}
				}
			},

			async onClose(event, ws) {
				if (!quizId) return;

				const awareness = roomAwareness.get(quizId);
				if (awareness) {
					const clientIDs = clientIDsByWs.get(ws);
					if (clientIDs && clientIDs.size > 0) {
						removeAwarenessStates(awareness, Array.from(clientIDs), "server");
					}
				}

				const clients = roomClients.get(quizId);
				if (clients) {
					clients.delete(ws);
					if (clients.size === 0) {
						roomClients.delete(quizId);
						roomAwareness.delete(quizId);

						const doc = quizRooms.get(quizId);
						if (doc) {
							if (saveTimeouts.has(quizId)) {
								clearTimeout(saveTimeouts.get(quizId)!);
								saveTimeouts.delete(quizId);
							}
							lastSaved.delete(quizId);
							await persistQuizToDatabase(quizId, doc);
							quizRooms.delete(quizId);
						}
					}
				}
			}
		};
	})
);
