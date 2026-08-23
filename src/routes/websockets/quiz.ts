import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import * as Y from "yjs";
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

export const quizWs = new Hono();

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

/**
 * Parses the Yjs Document, validates untrusted client data, and saves questions and options safely to PostgreSQL.
 */
async function persistQuizToDatabase(quizId: string, doc: Y.Doc) {
	try {
		console.log(`[Quiz DB] Persisting quiz ${quizId}...`);

		const stateVector = Y.encodeStateAsUpdate(doc);
		const base64State = Buffer.from(stateVector).toString("base64");

		const quizMeta = doc.getMap<string>("quizMeta");

		const rawQuizName = quizMeta.get("name");
		const safeQuizName =
			typeof rawQuizName === "string" && rawQuizName.trim().length > 0
				? rawQuizName.trim().substring(0, 255)
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

			// Deleting questions will cascade and delete old quizOptions automatically
			await tx.delete(questions).where(eq(questions.quizId, quizId));

			if (questionsArray.length > 0) {
				const questionsToInsert: NewQuestion[] = [];
				const optionsToInsert: NewQuizOption[] = [];

				questionsArray.forEach((q, index) => {
					const rawId = q.id;
					if (!rawId || typeof rawId !== "string" || !UUID_REGEX.test(rawId)) {
						console.warn(`[Quiz DB] Dropping question at index ${index} due to invalid UUID.`);
						return;
					}

					let safeType = typeof q.type === "string" ? q.type : "quiz";
					if (safeType === "Multiple choice") safeType = "quiz";
					if (!VALID_TYPES.has(safeType)) safeType = "quiz";

					const safeText = typeof q.text === "string" ? q.text.trim().substring(0, 250) : "";

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
							const optText = typeof opt.text === "string" ? opt.text.trim().substring(0, 100) : "";
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

		console.log(`[Quiz DB] Successfully persisted quiz ${quizId}.`);
	} catch (error) {
		console.error(`[Quiz DB] Failed to persist quiz ${quizId}:`, error);
	}
}

function scheduleSave(quizId: string, doc: Y.Doc) {
	if (saveTimeouts.has(quizId)) clearTimeout(saveTimeouts.get(quizId)!);

	const timeout = setTimeout(() => {
		persistQuizToDatabase(quizId, doc);
		saveTimeouts.delete(quizId);
	}, 3000);

	saveTimeouts.set(quizId, timeout);
}

quizWs.get(
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

		const RBACResult = hasPermission({
			userId: authResult.userID,
			workspaceId: quiz.workspaceId,
			teamId: quiz.teamId ?? undefined,
			permissionKey: "quiz:edit"
		});

		const [collaborator] = await database
			.select({ id: quizCollaborators.id })
			.from(quizCollaborators)
			.where(
				and(eq(quizCollaborators.quizId, quizId), eq(quizCollaborators.userId, authResult.userID))
			)
			.limit(1);

		if (!RBACResult && !collaborator) {
			return c.json({ error: "Forbidden: Missing required permission" }, 403);
		}

		await next();
	},
	upgradeWebSocket((c) => {
		const quizId = c.req.param("quizId");

		return {
			async onOpen(event, ws) {
				if (!quizId) {
					ws.close(400, "Missing quizID");
					return;
				}

				if (!roomClients.has(quizId)) roomClients.set(quizId, new Set());
				roomClients.get(quizId)?.add(ws);

				let doc = quizRooms.get(quizId);
				if (!doc) {
					doc = new Y.Doc();

					const [quizRecord] = await database
						.select({ state: quizzes.state, name: quizzes.name })
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

					quizRooms.set(quizId, doc);
				}

				// Send document state update prefixed with byte 0 (Doc Update)
				const docState = Y.encodeStateAsUpdate(doc);
				const message = new Uint8Array(1 + docState.length);
				message[0] = 0; // Message Type 0: Document Update
				message.set(docState, 1);
				ws.send(message.buffer);
			},

			onMessage(event, ws) {
				if (!quizId) return;
				const doc = quizRooms.get(quizId);
				if (!doc) return;

				const data = new Uint8Array(event.data as ArrayBuffer);
				if (data.length === 0) return;

				const messageType = data[0]; // 0 = Doc Update, 1 = Awareness Update
				const payload = data.subarray(1);

				if (messageType === 0) {
					Y.applyUpdate(doc, payload);
					scheduleSave(quizId, doc);
				}

				// Relay binary update (Doc or Awareness) to all other connected peers in the room
				const clients = roomClients.get(quizId);
				if (clients) {
					for (const client of clients) {
						if (client !== ws) client.send(data);
					}
				}
			},

			async onClose(event, ws) {
				if (!quizId) return;
				const clients = roomClients.get(quizId);
				if (clients) {
					clients.delete(ws);
					if (clients.size === 0) {
						roomClients.delete(quizId);
						const doc = quizRooms.get(quizId);
						if (doc) {
							if (saveTimeouts.has(quizId)) {
								clearTimeout(saveTimeouts.get(quizId)!);
								saveTimeouts.delete(quizId);
							}
							await persistQuizToDatabase(quizId, doc);
							quizRooms.delete(quizId);
						}
					}
				}
			}
		};
	})
);
