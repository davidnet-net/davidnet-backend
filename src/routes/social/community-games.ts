import AdmZip from "adm-zip";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { and, desc, eq, inArray,sql } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import {
	accountModerationStatus,
	communityGame,
	communityGameAuditLog,
	communityGameHighscores,
	communityGameLikes,
	communityGameSaves,
	communityGameSessions,
	internalAccess,
	users
} from "../../core/database/schema/schema";
import { getFromBucket, listBucketObjects,uploadToBucket } from "../../core/shared/s3";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const communityGamesRoute = new Hono<Env>();

// Max size (in characters of the JSON string) allowed for a single save blob.
const MAX_SAVE_JSON_LENGTH = 200_000;
const MAX_HIGHSCORE_VALUE = 1_000_000_000_000;

// --- ANTI-CHEAT: per-session signed highscore submissions ---
const SESSION_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const SESSION_TIMESTAMP_SKEW_MS = 2 * 60 * 1000; // 2 minutes
const HEX_PATTERN = /^[0-9a-f]+$/i;

// --- HELPER: CHECK IF USER IS BANNED ---
async function checkIfBanned(userId: string, c: any): Promise<boolean> {
	try {
		const [status] = await database
			.select()
			.from(accountModerationStatus)
			.where(eq(accountModerationStatus.userId, userId))
			.limit(1);

		if (!status || !status.bannedUntil) {
			return false;
		}

		const now = new Date();
		const bannedUntilDate = new Date(status.bannedUntil);

		if (bannedUntilDate <= now) {
			await database
				.update(accountModerationStatus)
				.set({ bannedUntil: null, updatedAt: now })
				.where(eq(accountModerationStatus.userId, userId));

			return false;
		}

		return true;
	} catch (error) {
		console.error("Failed to verify ban status:", error);
		return false;
	}
}

// --- HELPER: CHECK MODERATOR PERMISSIONS ---
async function isModerator(userId: string): Promise<boolean> {
	const [access] = await database
		.select({
			internalAccess: internalAccess.internalAccess,
			supportAccess: internalAccess.supportAccess
		})
		.from(internalAccess)
		.where(eq(internalAccess.userId, userId))
		.limit(1);

	return Boolean(access && access.internalAccess && access.supportAccess);
}

// --- HELPER: CHECK IF USER CAN MANAGE A GAME'S PLAYER DATA (creator OR moderator) ---
async function canManageGame(gameId: string, userId: string): Promise<boolean> {
	const [game] = await database
		.select({ userId: communityGame.userId })
		.from(communityGame)
		.where(eq(communityGame.id, gameId))
		.limit(1);

	if (!game) return false;
	if (game.userId === userId) return true;

	return await isModerator(userId);
}

// --- HELPER: WRITE A CREATOR AUDIT LOG ENTRY ---
async function logGameAudit(entry: {
	gameId: string;
	creatorId: string;
	targetUserId?: string | null;
	action: "view_save" | "edit_save" | "delete_save" | "edit_highscore" | "delete_highscore";
	details?: unknown;
}): Promise<void> {
	try {
		await database.insert(communityGameAuditLog).values({
			gameId: entry.gameId,
			creatorId: entry.creatorId,
			targetUserId: entry.targetUserId ?? null,
			action: entry.action,
			details: entry.details ?? null
		});
	} catch (error) {
		console.error("Failed to write community game audit log entry:", error);
	}
}

// --- HELPER: VERIFY A SIGNED, SESSION-BOUND SCORE SUBMISSION ---
// The session secret only ever lives inside the injected game-SDK script's closure (see the
// upload route below), so a request can only be correctly signed by code actually running inside
// that specific iframe's session - not by a script crafting postMessage calls from the parent
// page's own console using the secret-less global `window.DavidnetSDK`.
async function verifyGameSession(params: {
	sessionId: string;
	gameId: string;
	userId: string;
	score: number;
	timestamp: number;
	signature: string;
}): Promise<{ valid: true } | { valid: false; code: string }> {
	const { sessionId, gameId, userId, score, timestamp, signature } = params;

	if (!HEX_PATTERN.test(signature) || signature.length % 2 !== 0) {
		return { valid: false, code: "INVALID_SIGNATURE" };
	}

	const [session] = await database
		.select()
		.from(communityGameSessions)
		.where(eq(communityGameSessions.id, sessionId))
		.limit(1);

	if (!session || session.gameId !== gameId || session.userId !== userId) {
		return { valid: false, code: "INVALID_SESSION" };
	}

	if (session.expiresAt.getTime() < Date.now()) {
		return { valid: false, code: "SESSION_EXPIRED" };
	}

	if (Math.abs(Date.now() - timestamp) > SESSION_TIMESTAMP_SKEW_MS) {
		return { valid: false, code: "TIMESTAMP_OUT_OF_RANGE" };
	}

	// Timestamps must strictly increase per session so a previously-valid signed request can't be
	// captured and replayed later to re-apply (or re-flag) the same score.
	if (timestamp <= session.lastSignedTimestamp) {
		return { valid: false, code: "REPLAYED_REQUEST" };
	}

	const expectedSignature = createHmac("sha256", session.secret)
		.update(`${sessionId}:${gameId}:${score}:${timestamp}`)
		.digest("hex");

	const signatureBuffer = Buffer.from(signature, "hex");
	const expectedBuffer = Buffer.from(expectedSignature, "hex");

	if (
		signatureBuffer.length !== expectedBuffer.length ||
		!timingSafeEqual(signatureBuffer, expectedBuffer)
	) {
		return { valid: false, code: "INVALID_SIGNATURE" };
	}

	await database
		.update(communityGameSessions)
		.set({ lastSignedTimestamp: timestamp })
		.where(eq(communityGameSessions.id, sessionId));

	return { valid: true };
}

// --- 1. UPLOAD COMMUNITY GAME ---
communityGamesRoute.post("/upload", requireAuth, async (c) => {
	const userId = c.get("user").id;

	if (await checkIfBanned(userId, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const body = await c.req.parseBody();
	const title = body["title"];
	const description = body["description"];
	const file = body["game"];
	const isAiGenerated = body["isAiGenerated"] === "true";

	if (typeof title !== "string" || title.trim().length === 0) {
		return c.json({ success: false, code: "MISSING_TITLE" }, 400);
	}

	if (!file || !(file instanceof File)) {
		return c.json({ success: false, code: "MISSING_ZIP_FILE" }, 400);
	}

	if (
		!file.name.endsWith(".zip") &&
		file.type !== "application/zip" &&
		file.type !== "application/x-zip-compressed"
	) {
		return c.json(
			{ success: false, code: "INVALID_FILE_TYPE", message: "Only .zip files are allowed" },
			400
		);
	}

	try {
		const [newGame] = await database
			.insert(communityGame)
			.values({
				userId: userId,
				title: title.trim(),
				description: typeof description === "string" ? description.trim() : null,
				isModerated: false,
				isAiGenerated
			})
			.returning();

		const gameId = newGame.id;

		const buffer = Buffer.from(await file.arrayBuffer());
		const zip = new AdmZip(buffer);
		const zipEntries = zip.getEntries();

		let hasIndexHtml = false;

		const uploadPromises = zipEntries.map(async (entry) => {
			if (entry.isDirectory) return;

			const filePath = entry.entryName;
			if (filePath === "index.html") hasIndexHtml = true;

			// Use 'let' so we can overwrite fileData if it's an HTML file
			let fileData = entry.getData();
			const s3Key = `${gameId}/${filePath}`;

			let contentType = "application/octet-stream";

			// Inject LocalStorage Polyfill into HTML files
			if (filePath.endsWith(".html")) {
				contentType = "text/html";

				let htmlContent = fileData.toString("utf-8");

				// Safe in-memory storage mock that prevents the game from crashing
				const storagePolyfill = `
                <script>
                    (function() {
                        try {
                            var memStorage = {};
                            var mockStorage = {
                                getItem: function(k) { return memStorage.hasOwnProperty(k) ? memStorage[k] : null; },
                                setItem: function(k, v) { memStorage[k] = String(v); },
                                removeItem: function(k) { delete memStorage[k]; },
                                clear: function() { memStorage = {}; },
                                key: function(i) { return Object.keys(memStorage)[i] || null; },
                                get length() { return Object.keys(memStorage).length; }
                            };
                            Object.defineProperty(window, 'localStorage', { value: mockStorage, configurable: true, writable: true });
                            Object.defineProperty(window, 'sessionStorage', { value: mockStorage, configurable: true, writable: true });
                        } catch(e) {
                            console.warn("Could not polyfill storage");
                        }
                    })();
                </script>
                `;

				// SDK bridge: exposes window.DavidnetSDK.{applyHighscore,getHighscores,saveJsonBlob,getJsonBlob}
				// by round-tripping postMessage calls through the parent player page, which holds the
				// authenticated session the sandboxed iframe can never access directly.
				//
				// Anti-cheat: a per-session secret is fetched once from the server via "startSession" and
				// kept only in this closure (never attached to window.DavidnetSDK). applyHighscore signs
				// every submission with it (HMAC-SHA256), so a score can only be forged by code that runs
				// inside this exact iframe session - not by postMessage calls crafted from the parent page's
				// own devtools console using the secret-less global SDK object.
				const gameSdkScript = `
                <script>
                    (function() {
                        try {
                            var DN_SOURCE = "davidnet-game-sdk";
                            var GAME_ID = "${gameId}";
                            var pending = {};

                            function uid() {
                                return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
                            }

                            function call(type, payload) {
                                return new Promise(function(resolve, reject) {
                                    var requestId = uid();
                                    var timeoutId = setTimeout(function() {
                                        delete pending[requestId];
                                        reject(new Error("DavidnetSDK: \\"" + type + "\\" timed out"));
                                    }, 10000);

                                    pending[requestId] = function(message) {
                                        clearTimeout(timeoutId);
                                        if (message.success) {
                                            resolve(message.data);
                                        } else {
                                            reject(new Error(message.error || "DavidnetSDK: unknown error"));
                                        }
                                    };

                                    window.parent.postMessage(
                                        { source: DN_SOURCE, type: type, requestId: requestId, payload: payload },
                                        "*"
                                    );
                                });
                            }

                            window.addEventListener("message", function(event) {
                                var message = event.data;
                                if (!message || message.source !== DN_SOURCE || !message.requestId) return;
                                var handler = pending[message.requestId];
                                if (!handler) return;
                                delete pending[message.requestId];
                                handler(message);
                            });

                            function hexFromBuffer(buffer) {
                                var bytes = new Uint8Array(buffer);
                                var hex = "";
                                for (var i = 0; i < bytes.length; i++) {
                                    hex += bytes[i].toString(16).padStart(2, "0");
                                }
                                return hex;
                            }

                            function signMessage(secret, message) {
                                var enc = new TextEncoder();
                                return crypto.subtle
                                    .importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
                                    .then(function(key) {
                                        return crypto.subtle.sign("HMAC", key, enc.encode(message));
                                    })
                                    .then(hexFromBuffer);
                            }

                            // Fetched once per page load; the secret never leaves this closure.
                            var sessionReady = call("startSession", {});

                            window.DavidnetSDK = {
                                // Submit a score. Server keeps the best score per-player and globally.
                                // Resolves: { score, playerHighscore, globalHighscore, isNewPersonalBest, isNewGlobalBest }
                                applyHighscore: function(score) {
                                    return sessionReady.then(function(session) {
                                        var timestamp = Date.now();
                                        var message = session.sessionId + ":" + GAME_ID + ":" + score + ":" + timestamp;
                                        return signMessage(session.secret, message).then(function(signature) {
                                            return call("applyHighscore", {
                                                score: score,
                                                sessionId: session.sessionId,
                                                timestamp: timestamp,
                                                signature: signature
                                            });
                                        });
                                    });
                                },
                                // Resolves: { playerHighscore, globalHighscore, leaderboard: [{ rank, username, displayName, avatarUrl, score }] (top 10) }
                                getHighscores: function() {
                                    return call("getHighscores", {});
                                },
                                // Persist an arbitrary JSON-serializable save object (max ~200kb). Resolves: { savedAt }
                                saveJsonBlob: function(data) {
                                    return call("saveJsonBlob", { data: data });
                                },
                                // Resolves: { data, updatedAt } — data is null if nothing was saved yet.
                                getJsonBlob: function() {
                                    return call("getJsonBlob", {});
                                }
                            };
                        } catch(e) {
                            console.warn("Could not initialize DavidnetSDK", e);
                        }
                    })();
                </script>
                `;

				// Plaats de scripts direct na de <head> tag of helemaal bovenaan
				if (htmlContent.toLowerCase().includes("<head>")) {
					htmlContent = htmlContent.replace(
						/<head>/i,
						"<head>\n" + storagePolyfill + gameSdkScript
					);
				} else {
					htmlContent = storagePolyfill + gameSdkScript + htmlContent;
				}

				// Zet de aangepaste string weer om naar een Buffer voor S3
				fileData = Buffer.from(htmlContent, "utf-8");
			} else if (filePath.endsWith(".css")) {
				contentType = "text/css";
			} else if (filePath.endsWith(".js")) {
				contentType = "application/javascript";
			} else if (filePath.endsWith(".png")) {
				contentType = "image/png";
			} else if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) {
				contentType = "image/jpeg";
			} else if (filePath.endsWith(".mp3")) {
				contentType = "audio/mpeg";
			} else if (filePath.endsWith(".wav")) {
				contentType = "audio/wav";
			} else if (filePath.endsWith(".svg")) {
				contentType = "image/svg+xml";
			}

			await uploadToBucket("communitygames", s3Key, fileData, contentType);
		});

		await Promise.all(uploadPromises);

		if (!hasIndexHtml) {
			await database.delete(communityGame).where(eq(communityGame.id, gameId));
			return c.json(
				{
					success: false,
					code: "MISSING_INDEX_HTML",
					message: "ZIP must contain an index.html at the root."
				},
				400
			);
		}

		return c.json({ success: true, code: "GAME_UPLOADED", game: newGame });
	} catch (error) {
		console.error("Failed to upload community game:", error);
		return c.json({ success: false, code: "UPLOAD_FAILED" }, 500);
	}
});
// --- 2. GET COMMUNITY GAMES FEED ---
communityGamesRoute.get("/feed", requireAuth, async (c) => {
	const user = c.get("user");
	if (user && (await checkIfBanned(user.id, c))) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	try {
		const games = await database
			.select({
				id: communityGame.id,
				title: communityGame.title,
				description: communityGame.description,
				likesCount: communityGame.likesCount,
				isAiGenerated: communityGame.isAiGenerated,
				createdAt: communityGame.createdAt,
				creator: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatarUrl: users.avatarUrl
			})
			.from(communityGame)
			.innerJoin(users, eq(communityGame.userId, users.userId))
			.where(eq(communityGame.isModerated, false))
			.orderBy(desc(communityGame.createdAt))
			.limit(20);

		return c.json({ success: true, code: "SUCCESS", games });
	} catch (error) {
		console.error("Failed to fetch community games feed:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 2B. GET MY CREATOR-ACTION AUDIT LOG (actions OTHER creators/mods applied to MY data) ---
communityGamesRoute.get("/audit-log/mine", requireAuth, async (c) => {
	const userId = c.get("user").id;

	try {
		const entries = await database
			.select({
				id: communityGameAuditLog.id,
				gameId: communityGameAuditLog.gameId,
				gameTitle: communityGame.title,
				action: communityGameAuditLog.action,
				details: communityGameAuditLog.details,
				createdAt: communityGameAuditLog.createdAt,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName
			})
			.from(communityGameAuditLog)
			.innerJoin(communityGame, eq(communityGameAuditLog.gameId, communityGame.id))
			.innerJoin(users, eq(communityGameAuditLog.creatorId, users.userId))
			.where(eq(communityGameAuditLog.targetUserId, userId))
			.orderBy(desc(communityGameAuditLog.createdAt))
			.limit(100);

		return c.json({ success: true, code: "SUCCESS", entries });
	} catch (error) {
		console.error("Failed to fetch audit log:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 3. LIKE / UNLIKE COMMUNITY GAME ---
communityGamesRoute.post("/:id/like", requireAuth, async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ success: false, code: "UNAUTHORIZED" }, 401);
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const liked = Boolean(body.liked);

	try {
		if (liked) {
			await database
				.insert(communityGameLikes)
				.values({ userId: user.id, gameId })
				.onConflictDoNothing();
		} else {
			await database
				.delete(communityGameLikes)
				.where(and(eq(communityGameLikes.userId, user.id), eq(communityGameLikes.gameId, gameId)));
		}

		const [{ count }] = await database
			.select({ count: sql<number>`count(*)::int` })
			.from(communityGameLikes)
			.where(eq(communityGameLikes.gameId, gameId));

		await database
			.update(communityGame)
			.set({ likesCount: count })
			.where(eq(communityGame.id, gameId));

		return c.json({ success: true, code: "SUCCESS", likesCount: count });
	} catch (error) {
		console.error("Failed to toggle like:", error);
		return c.json({ success: false, code: "LIKE_FAILED" }, 500);
	}
});

// --- 4. DELETE COMMUNITY GAME ---
communityGamesRoute.delete("/:id", requireAuth, async (c) => {
	const userId = c.get("user").id;
	if (await checkIfBanned(userId, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");

	try {
		const [game] = await database
			.select()
			.from(communityGame)
			.where(eq(communityGame.id, gameId))
			.limit(1);

		if (!game) {
			return c.json({ success: false, code: "NOT_FOUND" }, 404);
		}

		if (game.userId !== userId) {
			return c.json({ success: false, code: "FORBIDDEN" }, 403);
		}

		await database.delete(communityGame).where(eq(communityGame.id, gameId));

		return c.json({ success: true, code: "GAME_DELETED" });
	} catch (error) {
		console.error("Failed to delete game:", error);
		return c.json({ success: false, code: "DELETE_FAILED" }, 500);
	}
});

// --- 5. GET SINGLE COMMUNITY GAME (PLAY PAGE) ---
communityGamesRoute.get("/:id", requireAuth, async (c) => {
	const user = c.get("user");
	if (user && (await checkIfBanned(user.id, c))) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const id = c.req.param("id");
	const modCheck = user ? await isModerator(user.id) : false;

	try {
		const conditions = modCheck
			? eq(communityGame.id, id)
			: and(eq(communityGame.id, id), eq(communityGame.isModerated, false));

		const [game] = await database
			.select({
				id: communityGame.id,
				title: communityGame.title,
				description: communityGame.description,
				likesCount: communityGame.likesCount,
				isModerated: communityGame.isModerated,
				isAiGenerated: communityGame.isAiGenerated,
				createdAt: communityGame.createdAt,
				creator: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatarUrl: users.avatarUrl
			})
			.from(communityGame)
			.innerJoin(users, eq(communityGame.userId, users.userId))
			.where(conditions)
			.limit(1);

		if (!game) return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);

		let isLiked = false;
		if (user) {
			const [likeRecord] = await database
				.select({ userId: communityGameLikes.userId })
				.from(communityGameLikes)
				.where(and(eq(communityGameLikes.userId, user.id), eq(communityGameLikes.gameId, id)))
				.limit(1);

			isLiked = Boolean(likeRecord);
		}

		return c.json({
			success: true,
			code: "SUCCESS",
			game: {
				...game,
				isLiked
			}
		});
	} catch (error) {
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 6. MODERATE COMMUNITY GAME (Mods only) ---
communityGamesRoute.patch("/:id/moderate", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;
	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	const gameId = c.req.param("id");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	if (typeof body.isModerated !== "boolean") {
		return c.json({ success: false, code: "INVALID_FIELD" }, 400);
	}

	try {
		const [updatedGame] = await database
			.update(communityGame)
			.set({ isModerated: body.isModerated, updatedAt: new Date() })
			.where(eq(communityGame.id, gameId))
			.returning();

		if (!updatedGame) return c.json({ success: false, code: "NOT_FOUND" }, 404);

		return c.json({ success: true, code: "GAME_MODERATED", game: updatedGame });
	} catch (error) {
		console.error("Failed to moderate game:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- 7. GET COMMUNITY GAME FILE LIST (Mods only) ---
communityGamesRoute.get("/:id/files", requireAuth, async (c) => {
	const userId = c.get("user").id;
	if (await checkIfBanned(userId, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}
	if (!(await isModerator(userId))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	const gameId = c.req.param("id");
	try {
		const rawKeys = await listBucketObjects("communitygames", `${gameId}/`);
		const files = rawKeys.map((key) => key.replace(`${gameId}/`, "")).filter(Boolean);

		return c.json({ success: true, files });
	} catch (error) {
		console.error("Failed to list game files:", error);
		return c.json({ success: false, code: "LIST_FILES_FAILED" }, 500);
	}
});

// --- 8B. START A SIGNED GAME SESSION (anti-cheat) ---
// Called once by the injected game-SDK script when the iframe loads. The returned secret is kept
// only inside that script's closure and is required to sign any later /:id/highscore submission.
communityGamesRoute.post("/:id/session/start", requireAuth, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");

	try {
		const [game] = await database
			.select({ id: communityGame.id })
			.from(communityGame)
			.where(eq(communityGame.id, gameId))
			.limit(1);

		if (!game) return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);

		const secret = randomBytes(32).toString("hex");
		const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

		const [session] = await database
			.insert(communityGameSessions)
			.values({ gameId, userId: user.id, secret, expiresAt })
			.returning({ id: communityGameSessions.id, expiresAt: communityGameSessions.expiresAt });

		return c.json({
			success: true,
			code: "SESSION_STARTED",
			sessionId: session.id,
			secret,
			expiresAt: session.expiresAt
		});
	} catch (error) {
		console.error("Failed to start game session:", error);
		return c.json({ success: false, code: "SESSION_START_FAILED" }, 500);
	}
});

// --- 9. APPLY HIGHSCORE ---
communityGamesRoute.post("/:id/highscore", requireAuth, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const score = Number(body.score);
	if (
		!Number.isFinite(score) ||
		!Number.isInteger(score) ||
		score < 0 ||
		score > MAX_HIGHSCORE_VALUE
	) {
		return c.json({ success: false, code: "INVALID_SCORE" }, 400);
	}

	const sessionId = body.sessionId;
	const timestamp = Number(body.timestamp);
	const signature = body.signature;

	if (
		typeof sessionId !== "string" ||
		!Number.isFinite(timestamp) ||
		typeof signature !== "string"
	) {
		return c.json({ success: false, code: "MISSING_SESSION" }, 400);
	}

	const sessionCheck = await verifyGameSession({
		sessionId,
		gameId,
		userId: user.id,
		score,
		timestamp,
		signature
	});

	if (!sessionCheck.valid) {
		return c.json({ success: false, code: sessionCheck.code }, 403);
	}

	try {
		const [game] = await database
			.select({ id: communityGame.id })
			.from(communityGame)
			.where(eq(communityGame.id, gameId))
			.limit(1);

		if (!game) return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);

		const [prevGlobalTop] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(eq(communityGameHighscores.gameId, gameId))
			.orderBy(desc(communityGameHighscores.score))
			.limit(1);

		const [existing] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(
				and(eq(communityGameHighscores.gameId, gameId), eq(communityGameHighscores.userId, user.id))
			)
			.limit(1);

		const isNewPersonalBest = !existing || score > existing.score;

		if (isNewPersonalBest) {
			await database
				.insert(communityGameHighscores)
				.values({ gameId, userId: user.id, score })
				.onConflictDoUpdate({
					target: [communityGameHighscores.gameId, communityGameHighscores.userId],
					set: { score, updatedAt: new Date() }
				});
		}

		const playerHighscore = isNewPersonalBest ? score : existing!.score;
		const isNewGlobalBest = !prevGlobalTop || playerHighscore > prevGlobalTop.score;
		const globalHighscore = isNewGlobalBest ? playerHighscore : prevGlobalTop!.score;

		return c.json({
			success: true,
			code: "SUCCESS",
			score,
			playerHighscore,
			globalHighscore,
			isNewPersonalBest,
			isNewGlobalBest
		});
	} catch (error) {
		console.error("Failed to apply highscore:", error);
		return c.json({ success: false, code: "HIGHSCORE_FAILED" }, 500);
	}
});

// --- 10. GET HIGHSCORES (own + global leaderboard top 10) ---
communityGamesRoute.get("/:id/highscores", requireAuth, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");

	try {
		const leaderboard = await database
			.select({
				userId: communityGameHighscores.userId,
				score: communityGameHighscores.score,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl
			})
			.from(communityGameHighscores)
			.innerJoin(users, eq(communityGameHighscores.userId, users.userId))
			.where(eq(communityGameHighscores.gameId, gameId))
			.orderBy(desc(communityGameHighscores.score))
			.limit(10);

		const [own] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(
				and(eq(communityGameHighscores.gameId, gameId), eq(communityGameHighscores.userId, user.id))
			)
			.limit(1);

		const rankedLeaderboard = leaderboard.map((row, index) => ({ ...row, rank: index + 1 }));

		return c.json({
			success: true,
			code: "SUCCESS",
			playerHighscore: own?.score ?? null,
			globalHighscore: rankedLeaderboard[0] ?? null,
			leaderboard: rankedLeaderboard
		});
	} catch (error) {
		console.error("Failed to fetch highscores:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 11. SAVE JSON BLOB (own save) ---
communityGamesRoute.post("/:id/save", requireAuth, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	if (body.data === undefined) {
		return c.json({ success: false, code: "MISSING_DATA" }, 400);
	}

	const serialized = JSON.stringify(body.data);
	if (serialized.length > MAX_SAVE_JSON_LENGTH) {
		return c.json({ success: false, code: "SAVE_TOO_LARGE" }, 413);
	}

	try {
		const [game] = await database
			.select({ id: communityGame.id })
			.from(communityGame)
			.where(eq(communityGame.id, gameId))
			.limit(1);

		if (!game) return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);

		const now = new Date();
		await database
			.insert(communityGameSaves)
			.values({ gameId, userId: user.id, data: body.data, updatedAt: now })
			.onConflictDoUpdate({
				target: [communityGameSaves.gameId, communityGameSaves.userId],
				set: { data: body.data, updatedAt: now }
			});

		return c.json({ success: true, code: "SUCCESS", savedAt: now });
	} catch (error) {
		console.error("Failed to save json blob:", error);
		return c.json({ success: false, code: "SAVE_FAILED" }, 500);
	}
});

// --- 12. GET JSON BLOB (own save) ---
communityGamesRoute.get("/:id/save", requireAuth, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");

	try {
		const [save] = await database
			.select({ data: communityGameSaves.data, updatedAt: communityGameSaves.updatedAt })
			.from(communityGameSaves)
			.where(and(eq(communityGameSaves.gameId, gameId), eq(communityGameSaves.userId, user.id)))
			.limit(1);

		return c.json({
			success: true,
			code: "SUCCESS",
			data: save?.data ?? null,
			updatedAt: save?.updatedAt ?? null
		});
	} catch (error) {
		console.error("Failed to fetch json blob:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 13. WIPE OWN SAVE ---
communityGamesRoute.delete("/:id/save", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");

	try {
		await database
			.delete(communityGameSaves)
			.where(and(eq(communityGameSaves.gameId, gameId), eq(communityGameSaves.userId, user.id)));

		return c.json({ success: true, code: "SAVE_WIPED" });
	} catch (error) {
		console.error("Failed to wipe save:", error);
		return c.json({ success: false, code: "WIPE_FAILED" }, 500);
	}
});

// --- 14. MANAGE: LIST ALL PLAYER DATA (creator / mods only) ---
communityGamesRoute.get("/:id/manage/players", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");

	if (!(await canManageGame(gameId, user.id))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	try {
		const highscores = await database
			.select({
				userId: communityGameHighscores.userId,
				score: communityGameHighscores.score,
				updatedAt: communityGameHighscores.updatedAt
			})
			.from(communityGameHighscores)
			.where(eq(communityGameHighscores.gameId, gameId));

		const saves = await database
			.select({
				userId: communityGameSaves.userId,
				data: communityGameSaves.data,
				updatedAt: communityGameSaves.updatedAt
			})
			.from(communityGameSaves)
			.where(eq(communityGameSaves.gameId, gameId));

		const userIds = Array.from(
			new Set([...highscores.map((h) => h.userId), ...saves.map((s) => s.userId)])
		);

		const playerUsers =
			userIds.length > 0
				? await database
						.select({
							userId: users.userId,
							username: users.username,
							displayName: users.displayName,
							avatarUrl: users.avatarUrl
						})
						.from(users)
						.where(inArray(users.userId, userIds))
				: [];

		const highscoreMap = new Map(highscores.map((h) => [h.userId, h]));
		const saveMap = new Map(saves.map((s) => [s.userId, s]));

		const players = playerUsers.map((p) => ({
			...p,
			highscore: highscoreMap.get(p.userId)?.score ?? null,
			highscoreUpdatedAt: highscoreMap.get(p.userId)?.updatedAt ?? null,
			save: saveMap.get(p.userId)?.data ?? null,
			saveUpdatedAt: saveMap.get(p.userId)?.updatedAt ?? null
		}));

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId: null,
			action: "view_save",
			details: { bulkView: true, playerCount: players.length }
		});

		return c.json({ success: true, code: "SUCCESS", players });
	} catch (error) {
		console.error("Failed to fetch player data:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 15. MANAGE: EDIT A PLAYER'S SAVE (creator / mods only) ---
communityGamesRoute.patch("/:id/manage/saves/:userId", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");
	const targetUserId = c.req.param("userId");

	if (!(await canManageGame(gameId, user.id))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	if (body.data === undefined) {
		return c.json({ success: false, code: "MISSING_DATA" }, 400);
	}

	const serialized = JSON.stringify(body.data);
	if (serialized.length > MAX_SAVE_JSON_LENGTH) {
		return c.json({ success: false, code: "SAVE_TOO_LARGE" }, 413);
	}

	try {
		const [previous] = await database
			.select({ data: communityGameSaves.data })
			.from(communityGameSaves)
			.where(
				and(eq(communityGameSaves.gameId, gameId), eq(communityGameSaves.userId, targetUserId))
			)
			.limit(1);

		const now = new Date();
		await database
			.insert(communityGameSaves)
			.values({ gameId, userId: targetUserId, data: body.data, updatedAt: now })
			.onConflictDoUpdate({
				target: [communityGameSaves.gameId, communityGameSaves.userId],
				set: { data: body.data, updatedAt: now }
			});

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "edit_save",
			details: { previousData: previous?.data ?? null, newData: body.data }
		});

		return c.json({ success: true, code: "SUCCESS", updatedAt: now });
	} catch (error) {
		console.error("Failed to edit player save:", error);
		return c.json({ success: false, code: "EDIT_FAILED" }, 500);
	}
});

// --- 16. MANAGE: DELETE A PLAYER'S SAVE (creator / mods only) ---
communityGamesRoute.delete("/:id/manage/saves/:userId", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");
	const targetUserId = c.req.param("userId");

	if (!(await canManageGame(gameId, user.id))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	try {
		const [previous] = await database
			.select({ data: communityGameSaves.data })
			.from(communityGameSaves)
			.where(
				and(eq(communityGameSaves.gameId, gameId), eq(communityGameSaves.userId, targetUserId))
			)
			.limit(1);

		await database
			.delete(communityGameSaves)
			.where(
				and(eq(communityGameSaves.gameId, gameId), eq(communityGameSaves.userId, targetUserId))
			);

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "delete_save",
			details: { deletedData: previous?.data ?? null }
		});

		return c.json({ success: true, code: "SUCCESS" });
	} catch (error) {
		console.error("Failed to delete player save:", error);
		return c.json({ success: false, code: "DELETE_FAILED" }, 500);
	}
});

// --- 17. MANAGE: EDIT A PLAYER'S HIGHSCORE (creator / mods only) ---
communityGamesRoute.patch("/:id/manage/highscores/:userId", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");
	const targetUserId = c.req.param("userId");

	if (!(await canManageGame(gameId, user.id))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const score = Number(body.score);
	if (
		!Number.isFinite(score) ||
		!Number.isInteger(score) ||
		score < 0 ||
		score > MAX_HIGHSCORE_VALUE
	) {
		return c.json({ success: false, code: "INVALID_SCORE" }, 400);
	}

	try {
		const [previous] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId)
				)
			)
			.limit(1);

		const now = new Date();
		await database
			.insert(communityGameHighscores)
			.values({ gameId, userId: targetUserId, score, updatedAt: now })
			.onConflictDoUpdate({
				target: [communityGameHighscores.gameId, communityGameHighscores.userId],
				set: { score, updatedAt: now }
			});

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "edit_highscore",
			details: { previousScore: previous?.score ?? null, newScore: score }
		});

		return c.json({ success: true, code: "SUCCESS", score });
	} catch (error) {
		console.error("Failed to edit player highscore:", error);
		return c.json({ success: false, code: "EDIT_FAILED" }, 500);
	}
});

// --- 18. MANAGE: DELETE A PLAYER'S HIGHSCORE (creator / mods only) ---
communityGamesRoute.delete("/:id/manage/highscores/:userId", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");
	const targetUserId = c.req.param("userId");

	if (!(await canManageGame(gameId, user.id))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	try {
		const [previous] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId)
				)
			)
			.limit(1);

		await database
			.delete(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId)
				)
			);

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "delete_highscore",
			details: { deletedScore: previous?.score ?? null }
		});

		return c.json({ success: true, code: "SUCCESS" });
	} catch (error) {
		console.error("Failed to delete player highscore:", error);
		return c.json({ success: false, code: "DELETE_FAILED" }, 500);
	}
});

// --- 8. SERVE GAME FILES (FOR THE IFRAME) ---
communityGamesRoute.get("/:id/file/*", async (c) => {
	const id = c.req.param("id");
	const url = new URL(c.req.url);
	const filePath = url.pathname.split(`/file/`)[1];

	if (!id || !filePath) return c.json({ error: "Missing parameters" }, 400);

	const s3Key = `${id}/${filePath}`;

	try {
		const s3Object = await getFromBucket("communitygames", s3Key);
		if (!s3Object.Body) return c.json({ error: "File not found" }, 404);

		c.header("Content-Type", s3Object.ContentType || "application/octet-stream");
		c.header("Cache-Control", "public, max-age=86400");

		// Allow CORS requests from the sandboxed opaque (null) origin
		c.header("Access-Control-Allow-Origin", "*");

		// Permissive CSP for external assets (Tailwind, Google Fonts) while restricting origin privilege
		c.header(
			"Content-Security-Policy",
			"default-src * https: http: 'unsafe-inline' 'unsafe-eval' data: blob:; " +
				"img-src * https: http: data: blob:; " +
				"media-src * https: http: data: blob:; " +
				"font-src * https: http: data:; " +
				"style-src * https: http: 'unsafe-inline'; " +
				"script-src * https: http: 'unsafe-inline' 'unsafe-eval';"
		);

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "File not found" }, 404);
	}
});
