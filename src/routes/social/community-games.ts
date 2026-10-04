import AdmZip from "adm-zip";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
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
import { deleteFromBucket,getFromBucket, listBucketObjects,uploadToBucket } from "../../core/shared/s3";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const communityGamesRoute = new Hono<Env>();

// Max size (in characters of the JSON string) allowed for a single save blob.
const MAX_SAVE_JSON_LENGTH = 200_000;
// Absolute sanity ceiling. Not per-game configurable on purpose: it's a last-resort backstop
// against nonsense values (e.g. someone setting it to 30 billion); the anomaly flag below is what
// actually adapts to what's reasonable for a specific game.
const MAX_HIGHSCORE_VALUE = 100_000_000;

// --- ICON UPLOAD ---
const ALLOWED_ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];
const MAX_ICON_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

// --- ANTI-CHEAT: per-session signed highscore submissions ---
const SESSION_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const SESSION_TIMESTAMP_SKEW_MS = 2 * 60 * 1000; // 2 minutes
// A submission claiming to come from a session that only just started can't reflect real play.
const MIN_SESSION_AGE_MS = 1_500;
// Cooldown between accepted submissions from the same session, to stop someone script-probing
// many candidate scores in rapid succession to find one that slips under the anomaly threshold.
const MIN_SUBMIT_INTERVAL_MS = 2_000;
const HEX_PATTERN = /^[0-9a-f]+$/i;

// --- ANTI-CHEAT: anomaly flagging ---
// A new score that blows way past the current (unflagged) leaderboard top gets stored but
// excluded from the public leaderboard until a creator/moderator clears the flag. Only kicks in
// once there's a real baseline, so the first few legitimate plays of a brand new game aren't
// flagged against each other.
const ANOMALY_SCORE_MULTIPLIER = 5;
const ANOMALY_MIN_SAMPLE_SIZE = 3;

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
	action:
		| "view_save"
		| "edit_save"
		| "delete_save"
		| "edit_highscore"
		| "delete_highscore"
		| "approve_highscore";
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
	// The value being attested to - the score for a highscore submission, or a hash of the
	// serialized save blob for a save submission.
	payload: string;
	timestamp: number;
	signature: string;
}): Promise<{ valid: true } | { valid: false; code: string }> {
	const { sessionId, gameId, userId, payload, timestamp, signature } = params;

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

	// A score can't be legitimate if it's submitted the instant the session was created.
	if (timestamp - session.createdAt.getTime() < MIN_SESSION_AGE_MS) {
		return { valid: false, code: "SESSION_TOO_NEW" };
	}

	// Cooldown between accepted submissions, so a script can't rapid-fire candidate scores to probe
	// where the anomaly threshold sits.
	if (session.lastSignedTimestamp > 0 && timestamp - session.lastSignedTimestamp < MIN_SUBMIT_INTERVAL_MS) {
		return { valid: false, code: "RATE_LIMITED" };
	}

	const expectedSignature = createHmac("sha256", session.secret)
		.update(`${sessionId}:${gameId}:${payload}:${timestamp}`)
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
	const iconFile = body["icon"];
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

	// Icon is optional - if the creator doesn't upload one, the frontend falls back to a default icon.
	let iconFilename: string | null = null;
	if (iconFile !== undefined) {
		if (!(iconFile instanceof File)) {
			return c.json({ success: false, code: "INVALID_ICON_FILE" }, 400);
		}

		if (!ALLOWED_ICON_TYPES.includes(iconFile.type)) {
			return c.json({ success: false, code: "INVALID_ICON_TYPE" }, 400);
		}

		if (iconFile.size > MAX_ICON_SIZE_BYTES) {
			return c.json({ success: false, code: "ICON_TOO_LARGE" }, 400);
		}

		iconFilename = `icon.${iconFile.type.split("/")[1]}`;
	}

	try {
		const [newGame] = await database
			.insert(communityGame)
			.values({
				userId: userId,
				title: title.trim(),
				description: typeof description === "string" ? description.trim() : null,
				isModerated: false,
				isAiGenerated,
				iconFilename
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

                            var realtimeListeners = { message: [], presence: [], matched: [], disconnect: [], reconnect: [], error: [] };

                            function subscribe(kind, cb) {
                                realtimeListeners[kind].push(cb);
                                return function unsubscribe() {
                                    var idx = realtimeListeners[kind].indexOf(cb);
                                    if (idx !== -1) realtimeListeners[kind].splice(idx, 1);
                                };
                            }

                            function emit(kind, payload) {
                                var list = realtimeListeners[kind];
                                if (!list) return;
                                list.slice().forEach(function(cb) {
                                    try { cb(payload); } catch (e) { console.error("DavidnetSDK: realtime listener error", e); }
                                });
                            }

                            window.addEventListener("message", function(event) {
                                var message = event.data;
                                if (!message || message.source !== DN_SOURCE) return;

                                if (message.type === "event") {
                                    emit(message.event, message.payload);
                                    return;
                                }

                                if (!message.requestId) return;
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
                                    return sessionReady.then(function(session) {
                                        var serialized = JSON.stringify(data);
                                        var timestamp = Date.now();
                                        var enc = new TextEncoder();
                                        return crypto.subtle.digest("SHA-256", enc.encode(serialized))
                                            .then(hexFromBuffer)
                                            .then(function(dataHash) {
                                                var message = session.sessionId + ":" + GAME_ID + ":" + dataHash + ":" + timestamp;
                                                return signMessage(session.secret, message).then(function(signature) {
                                                    return call("saveJsonBlob", {
                                                        data: data,
                                                        sessionId: session.sessionId,
                                                        timestamp: timestamp,
                                                        signature: signature
                                                    });
                                                });
                                            });
                                    });
                                },
                                // Resolves: { data, updatedAt } — data is null if nothing was saved yet.
                                getJsonBlob: function() {
                                    return call("getJsonBlob", {});
                                },

                                // Generic real-time extension: rooms (pub/sub channels with presence) plus a
                                // matchmaking queue. Content-agnostic - the platform never inspects "data", so
                                // the same primitives work for a 2-player board game, a 50+ player shooter, or
                                // a one-way live feed (e.g. a price ticker) with no "match" concept at all.
                                // There is no maximum room size, queue size, or group size.
                                realtime: {
                                    // Opens the realtime connection. Called automatically by every other
                                    // realtime.* method, so you only need this if you want to connect early.
                                    connect: function() {
                                        return call("realtimeConnect", {});
                                    },
                                    // Joins a named room (created on first join, destroyed when empty). You can
                                    // join any number of rooms. Resolves: { room, members } - members is the
                                    // list of everyone already in the room when you joined.
                                    joinRoom: function(room) {
                                        return call("realtimeJoinRoom", { room: room });
                                    },
                                    // Resolves: { room }
                                    leaveRoom: function(room) {
                                        return call("realtimeLeaveRoom", { room: room });
                                    },
                                    // Broadcasts arbitrary JSON-serializable data to everyone else currently in
                                    // the room (pass { echo: true } to also receive your own message back via
                                    // onMessage). Fire-and-forget - does not wait for delivery.
                                    send: function(room, data, options) {
                                        return call("realtimeSend", {
                                            room: room,
                                            data: data,
                                            echo: !!(options && options.echo)
                                        });
                                    },
                                    // Joins a named matchmaking queue. All callers joining the same queue name
                                    // should agree on the same groupSize. Once "groupSize" callers are waiting,
                                    // the server pops them off (FIFO) and auto-creates a room for them - listen
                                    // with onMatched. "metadata" is optional and yours to use (e.g. skill level)
                                    // for your own custom matching logic built on top of this primitive.
                                    // Resolves: { queue, position }
                                    joinQueue: function(queue, groupSize, metadata) {
                                        return call("realtimeJoinQueue", {
                                            queue: queue,
                                            groupSize: groupSize,
                                            metadata: metadata
                                        });
                                    },
                                    // Resolves: { queue }
                                    leaveQueue: function(queue) {
                                        return call("realtimeLeaveQueue", { queue: queue });
                                    },
                                    // Fires for every message sent to a room you're in: { room, data, from, ts }.
                                    // Returns an unsubscribe function.
                                    onMessage: function(cb) { return subscribe("message", cb); },
                                    // Fires when someone joins/leaves a room you're in: { room, event, member }.
                                    onPresence: function(cb) { return subscribe("presence", cb); },
                                    // Fires when a queue you joined found a full group: { queue, room, members }.
                                    onMatched: function(cb) { return subscribe("matched", cb); },
                                    // Fires when the realtime connection drops unexpectedly (auto-reconnect is
                                    // attempted in the background; your room memberships are silently restored).
                                    onDisconnect: function(cb) { return subscribe("disconnect", cb); },
                                    // Fires after a successful auto-reconnect, with the rooms that were rejoined.
                                    onReconnect: function(cb) { return subscribe("reconnect", cb); },
                                    // Fires on a server-side error that isn't tied to a specific call, e.g. you
                                    // got rate-limited or sent to a room you're not in: { code, message }.
                                    onError: function(cb) { return subscribe("error", cb); }
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

		// Uploaded after the zip's own files, so a dedicated icon always wins over a same-named file
		// that happened to be packaged inside the zip.
		if (iconFile instanceof File && iconFilename) {
			const iconBuffer = Buffer.from(await iconFile.arrayBuffer());
			await uploadToBucket("communitygames", `${gameId}/${iconFilename}`, iconBuffer, iconFile.type);
		}

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

// --- 1B. UPDATE COMMUNITY GAME (replace the uploaded zip) ---
// Creator-only (same bar as deleting the game). Re-runs the exact same zip validation + SDK
// injection as the initial upload - keep this in sync with "--- 1. UPLOAD COMMUNITY GAME ---"
// above if that logic ever changes. The icon is left untouched; it's managed separately.
communityGamesRoute.put("/:id/upload", requireAuth, async (c) => {
	const userId = c.get("user").id;

	if (await checkIfBanned(userId, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");

	const [existingGame] = await database
		.select({ userId: communityGame.userId, iconFilename: communityGame.iconFilename })
		.from(communityGame)
		.where(eq(communityGame.id, gameId))
		.limit(1);

	if (!existingGame) return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);
	if (existingGame.userId !== userId) return c.json({ success: false, code: "FORBIDDEN" }, 403);

	const body = await c.req.parseBody();
	const file = body["game"];

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
		// Validate the zip has an index.html BEFORE deleting any existing files, so a bad upload
		// can't take down an already-working game.
		const precheckZip = new AdmZip(Buffer.from(await file.arrayBuffer()));
		const hasIndexHtmlEntry = precheckZip
			.getEntries()
			.some((entry) => entry.entryName === "index.html");

		if (!hasIndexHtmlEntry) {
			return c.json(
				{
					success: false,
					code: "MISSING_INDEX_HTML",
					message: "ZIP must contain an index.html at the root."
				},
				400
			);
		}

		// Remove the previous version's files (except the icon, which is managed separately) so
		// stale files the new zip doesn't include don't linger and stay servable.
		const existingKeys = await listBucketObjects("communitygames", `${gameId}/`);
		const iconKey = existingGame.iconFilename ? `${gameId}/${existingGame.iconFilename}` : null;
		await deleteFromBucket(
			"communitygames",
			existingKeys.filter((key) => key !== iconKey)
		);

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

                            var realtimeListeners = { message: [], presence: [], matched: [], disconnect: [], reconnect: [], error: [] };

                            function subscribe(kind, cb) {
                                realtimeListeners[kind].push(cb);
                                return function unsubscribe() {
                                    var idx = realtimeListeners[kind].indexOf(cb);
                                    if (idx !== -1) realtimeListeners[kind].splice(idx, 1);
                                };
                            }

                            function emit(kind, payload) {
                                var list = realtimeListeners[kind];
                                if (!list) return;
                                list.slice().forEach(function(cb) {
                                    try { cb(payload); } catch (e) { console.error("DavidnetSDK: realtime listener error", e); }
                                });
                            }

                            window.addEventListener("message", function(event) {
                                var message = event.data;
                                if (!message || message.source !== DN_SOURCE) return;

                                if (message.type === "event") {
                                    emit(message.event, message.payload);
                                    return;
                                }

                                if (!message.requestId) return;
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
                                    return sessionReady.then(function(session) {
                                        var serialized = JSON.stringify(data);
                                        var timestamp = Date.now();
                                        var enc = new TextEncoder();
                                        return crypto.subtle.digest("SHA-256", enc.encode(serialized))
                                            .then(hexFromBuffer)
                                            .then(function(dataHash) {
                                                var message = session.sessionId + ":" + GAME_ID + ":" + dataHash + ":" + timestamp;
                                                return signMessage(session.secret, message).then(function(signature) {
                                                    return call("saveJsonBlob", {
                                                        data: data,
                                                        sessionId: session.sessionId,
                                                        timestamp: timestamp,
                                                        signature: signature
                                                    });
                                                });
                                            });
                                    });
                                },
                                // Resolves: { data, updatedAt } — data is null if nothing was saved yet.
                                getJsonBlob: function() {
                                    return call("getJsonBlob", {});
                                },

                                // Generic real-time extension: rooms (pub/sub channels with presence) plus a
                                // matchmaking queue. Content-agnostic - the platform never inspects "data", so
                                // the same primitives work for a 2-player board game, a 50+ player shooter, or
                                // a one-way live feed (e.g. a price ticker) with no "match" concept at all.
                                // There is no maximum room size, queue size, or group size.
                                realtime: {
                                    // Opens the realtime connection. Called automatically by every other
                                    // realtime.* method, so you only need this if you want to connect early.
                                    connect: function() {
                                        return call("realtimeConnect", {});
                                    },
                                    // Joins a named room (created on first join, destroyed when empty). You can
                                    // join any number of rooms. Resolves: { room, members } - members is the
                                    // list of everyone already in the room when you joined.
                                    joinRoom: function(room) {
                                        return call("realtimeJoinRoom", { room: room });
                                    },
                                    // Resolves: { room }
                                    leaveRoom: function(room) {
                                        return call("realtimeLeaveRoom", { room: room });
                                    },
                                    // Broadcasts arbitrary JSON-serializable data to everyone else currently in
                                    // the room (pass { echo: true } to also receive your own message back via
                                    // onMessage). Fire-and-forget - does not wait for delivery.
                                    send: function(room, data, options) {
                                        return call("realtimeSend", {
                                            room: room,
                                            data: data,
                                            echo: !!(options && options.echo)
                                        });
                                    },
                                    // Joins a named matchmaking queue. All callers joining the same queue name
                                    // should agree on the same groupSize. Once "groupSize" callers are waiting,
                                    // the server pops them off (FIFO) and auto-creates a room for them - listen
                                    // with onMatched. "metadata" is optional and yours to use (e.g. skill level)
                                    // for your own custom matching logic built on top of this primitive.
                                    // Resolves: { queue, position }
                                    joinQueue: function(queue, groupSize, metadata) {
                                        return call("realtimeJoinQueue", {
                                            queue: queue,
                                            groupSize: groupSize,
                                            metadata: metadata
                                        });
                                    },
                                    // Resolves: { queue }
                                    leaveQueue: function(queue) {
                                        return call("realtimeLeaveQueue", { queue: queue });
                                    },
                                    // Fires for every message sent to a room you're in: { room, data, from, ts }.
                                    // Returns an unsubscribe function.
                                    onMessage: function(cb) { return subscribe("message", cb); },
                                    // Fires when someone joins/leaves a room you're in: { room, event, member }.
                                    onPresence: function(cb) { return subscribe("presence", cb); },
                                    // Fires when a queue you joined found a full group: { queue, room, members }.
                                    onMatched: function(cb) { return subscribe("matched", cb); },
                                    // Fires when the realtime connection drops unexpectedly (auto-reconnect is
                                    // attempted in the background; your room memberships are silently restored).
                                    onDisconnect: function(cb) { return subscribe("disconnect", cb); },
                                    // Fires after a successful auto-reconnect, with the rooms that were rejoined.
                                    onReconnect: function(cb) { return subscribe("reconnect", cb); },
                                    // Fires on a server-side error that isn't tied to a specific call, e.g. you
                                    // got rate-limited or sent to a room you're not in: { code, message }.
                                    onError: function(cb) { return subscribe("error", cb); }
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
			return c.json(
				{
					success: false,
					code: "MISSING_INDEX_HTML",
					message: "ZIP must contain an index.html at the root."
				},
				400
			);
		}

		await database
			.update(communityGame)
			.set({ updatedAt: new Date() })
			.where(eq(communityGame.id, gameId));

		return c.json({ success: true, code: "GAME_UPDATED" });
	} catch (error) {
		console.error("Failed to update community game:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
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
				iconFilename: communityGame.iconFilename,
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
				iconFilename: communityGame.iconFilename,
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
		payload: String(score),
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

		// Anomaly check uses only the current, already-trusted (unflagged) leaderboard as its baseline.
		const [prevGlobalTop] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(and(eq(communityGameHighscores.gameId, gameId), eq(communityGameHighscores.flagged, false)))
			.orderBy(desc(communityGameHighscores.score))
			.limit(1);

		const [{ sampleSize }] = await database
			.select({ sampleSize: sql<number>`count(*)::int` })
			.from(communityGameHighscores)
			.where(and(eq(communityGameHighscores.gameId, gameId), eq(communityGameHighscores.flagged, false)));

		const [existing] = await database
			.select({ score: communityGameHighscores.score, flagged: communityGameHighscores.flagged })
			.from(communityGameHighscores)
			.where(
				and(eq(communityGameHighscores.gameId, gameId), eq(communityGameHighscores.userId, user.id))
			)
			.limit(1);

		const isNewPersonalBest = !existing || score > existing.score;

		const isAnomalous =
			sampleSize >= ANOMALY_MIN_SAMPLE_SIZE &&
			!!prevGlobalTop &&
			score > prevGlobalTop.score * ANOMALY_SCORE_MULTIPLIER;

		if (isNewPersonalBest) {
			await database
				.insert(communityGameHighscores)
				.values({
					gameId,
					userId: user.id,
					score,
					flagged: isAnomalous,
					flagReason: isAnomalous
						? `Score is more than ${ANOMALY_SCORE_MULTIPLIER}x the current leaderboard top (${prevGlobalTop!.score}).`
						: null
				})
				.onConflictDoUpdate({
					target: [communityGameHighscores.gameId, communityGameHighscores.userId],
					set: {
						score,
						flagged: isAnomalous,
						flagReason: isAnomalous
							? `Score is more than ${ANOMALY_SCORE_MULTIPLIER}x the current leaderboard top (${prevGlobalTop!.score}).`
							: null,
						updatedAt: new Date()
					}
				});
		}

		const playerHighscore = isNewPersonalBest ? score : existing!.score;
		const playerHighscoreFlagged = isNewPersonalBest ? isAnomalous : (existing?.flagged ?? false);
		const isNewGlobalBest = !isAnomalous && (!prevGlobalTop || playerHighscore > prevGlobalTop.score);
		const globalHighscore = isNewGlobalBest ? playerHighscore : (prevGlobalTop?.score ?? playerHighscore);

		return c.json({
			success: true,
			code: "SUCCESS",
			score,
			playerHighscore,
			playerHighscoreFlagged,
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
		// Flagged scores are under review and excluded from everyone's public leaderboard view.
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
			.where(and(eq(communityGameHighscores.gameId, gameId), eq(communityGameHighscores.flagged, false)))
			.orderBy(desc(communityGameHighscores.score))
			.limit(10);

		const [own] = await database
			.select({ score: communityGameHighscores.score, flagged: communityGameHighscores.flagged })
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
			playerHighscoreFlagged: own?.flagged ?? false,
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

	// Sign over a hash of the save blob rather than the (up to 200kb) blob itself.
	const dataHash = createHash("sha256").update(serialized).digest("hex");

	const sessionCheck = await verifyGameSession({
		sessionId,
		gameId,
		userId: user.id,
		payload: dataHash,
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
				flagged: communityGameHighscores.flagged,
				flagReason: communityGameHighscores.flagReason,
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
			highscoreFlagged: highscoreMap.get(p.userId)?.flagged ?? false,
			highscoreFlagReason: highscoreMap.get(p.userId)?.flagReason ?? null,
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
			.values({ gameId, userId: targetUserId, score, flagged: false, flagReason: null, updatedAt: now })
			.onConflictDoUpdate({
				target: [communityGameHighscores.gameId, communityGameHighscores.userId],
				// A manual edit by a creator/mod is itself a form of approval - clear any anomaly flag.
				set: { score, flagged: false, flagReason: null, updatedAt: now }
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

// --- 17B. MANAGE: APPROVE A FLAGGED HIGHSCORE AS-IS (creator / mods only) ---
communityGamesRoute.post("/:id/manage/highscores/:userId/approve", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");
	const targetUserId = c.req.param("userId");

	if (!(await canManageGame(gameId, user.id))) {
		return c.json({ success: false, code: "FORBIDDEN" }, 403);
	}

	try {
		const [updated] = await database
			.update(communityGameHighscores)
			.set({ flagged: false, flagReason: null })
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId)
				)
			)
			.returning({ score: communityGameHighscores.score });

		if (!updated) return c.json({ success: false, code: "NOT_FOUND" }, 404);

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "approve_highscore",
			details: { approvedScore: updated.score }
		});

		return c.json({ success: true, code: "SUCCESS" });
	} catch (error) {
		console.error("Failed to approve player highscore:", error);
		return c.json({ success: false, code: "APPROVE_FAILED" }, 500);
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

		// Games can now be updated in place (PUT /:id/upload), so these files are no longer
		// immutable - an ETag + short max-age lets the browser cheaply revalidate (304) instead of
		// blindly trusting a stale cached copy for a full day after an update.
		const etag = s3Object.ETag;
		if (etag && c.req.header("If-None-Match") === etag) {
			return c.body(null, 304);
		}

		c.header("Content-Type", s3Object.ContentType || "application/octet-stream");
		c.header("Cache-Control", "public, max-age=60, must-revalidate");
		if (etag) c.header("ETag", etag);

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
				"script-src * https: http: 'unsafe-inline' 'unsafe-eval'; " +
				// Without this, connect-src falls back to the permissive default-src above, meaning a
				// game's own JS could fetch()/XHR/WebSocket to ANY third-party origin and exfiltrate
				// data - the SDK bridge (postMessage) is unaffected by this, it's not a "connection".
				// 'self' (not 'none') because some game engines (Unity/Godot WebGL exports, etc.) load
				// their own bundled .data/.wasm files via fetch from the same origin that served them.
				"connect-src 'self';"
		);

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "File not found" }, 404);
	}
});
