import AdmZip from "adm-zip";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import {
	accountModerationStatus,
	communityGame,
	communityGameAchievements,
	communityGameAuditLog,
	communityGameHighscores,
	communityGameLevels,
	communityGameLikes,
	communityGamePlaytime,
	communityGameSaves,
	communityGameSessions,
	DEFAULT_LEADERBOARD_CATEGORY,
	DEFAULT_SAVE_SLOT,
	internalAccess,
	userPreferences,
	userPrivacyPreferences,
	users
} from "../../core/database/schema/schema";
import { notifyActivity, contentUrlFor } from "../../core/shared/activityWebhook";
import {
	deleteFromBucket,
	getFromBucket,
	listBucketObjects,
	uploadToBucket
} from "../../core/shared/s3";
import { collectAuth } from "../../middlewares/collectAuth";
import { createRateLimiter } from "../../middlewares/rateLimiter";
import { type Env, requireAuth } from "../../middlewares/requireAuth";

export const communityGamesRoute = new Hono<Env>();

// --- SDK ACTION RATE LIMIT ---
// Everything reachable from window.DavidnetSDK inside a game's sandboxed iframe (highscores,
// saves, achievements, UGC levels) shares ONE bucket per player+game, completely separate from the
// global per-IP limiter in middlewares/index.ts. Without this, a buggy or malicious game calling an
// SDK method on every animation frame would either burn through that player's site-wide request
// budget (locking them out of everything else on davidnet.net, not just the game) or, if it slips
// under that generous 10000/15min ceiling, still hammer the database hard enough to slow the site
// down for everyone else. 60 requests per 10s (6/s sustained, bursts of 60) comfortably covers real
// usage - occasional score/save/achievement submissions, polling a leaderboard every few seconds -
// while quickly cutting off anything looping every frame.
const SDK_ACTION_LIMIT = 60;
const SDK_ACTION_WINDOW_MS = 10_000;
function sdkRateLimitKey(
	c: { get: (k: "user") => { id: string } },
	gameId: string | undefined
): string {
	return `cg-sdk:${c.get("user").id}:${gameId}`;
}
const sdkActionLimiter = createRateLimiter(SDK_ACTION_LIMIT, SDK_ACTION_WINDOW_MS, {
	keyFn: (c) => sdkRateLimitKey(c as never, c.req.param("id"))
});

// Max size (in characters of the JSON string) allowed for a single save blob. Raised from the
// original 200kb to 1MB - old saves (all well under 200kb) are unaffected, this only loosens the
// ceiling for new saves.
const MAX_SAVE_JSON_LENGTH = 1_000_000;
// Absolute sanity ceiling. Not per-game configurable on purpose: it's a last-resort backstop
// against nonsense values (e.g. someone setting it to 30 billion); the anomaly flag below is what
// actually adapts to what's reasonable for a specific game.
const MAX_HIGHSCORE_VALUE = 100_000_000;

// --- MULTIPLE LEADERBOARDS ---
// A game can submit scores under any number of named categories (e.g. "time-attack", "level-3").
// Omitting a category (every game uploaded before this feature existed, and any new game that
// doesn't bother) falls back to DEFAULT_LEADERBOARD_CATEGORY, reproducing the old single-leaderboard
// behavior exactly.
const MAX_CATEGORY_LENGTH = 50;
const CATEGORY_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sanitizeCategory(raw: unknown): string | null {
	if (raw === undefined || raw === null || raw === "") return DEFAULT_LEADERBOARD_CATEGORY;
	if (typeof raw !== "string") return null;
	if (raw.length > MAX_CATEGORY_LENGTH || !CATEGORY_PATTERN.test(raw)) return null;
	return raw;
}

// --- NAMED SAVE SLOTS ---
// A game can keep more than one save blob per player under any number of named slots (e.g.
// "hardcore", "slot-2"). Omitting a slot (every game uploaded before this feature existed, and any
// new game that doesn't bother) falls back to DEFAULT_SAVE_SLOT, reproducing the old
// single-save-per-player behavior exactly. Reuses the same charset rules as highscore categories.
function sanitizeSlot(raw: unknown): string | null {
	if (raw === undefined || raw === null || raw === "") return DEFAULT_SAVE_SLOT;
	if (typeof raw !== "string") return null;
	if (raw.length > MAX_CATEGORY_LENGTH || !CATEGORY_PATTERN.test(raw)) return null;
	return raw;
}

// --- ACHIEVEMENTS ---
const MAX_ACHIEVEMENT_ID_LENGTH = 100;
const MAX_ACHIEVEMENT_NAME_LENGTH = 200;
const MAX_ACHIEVEMENT_DESCRIPTION_LENGTH = 500;
const MAX_ACHIEVEMENT_ICON_LENGTH = 32;
const ACHIEVEMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Sanity ceiling for achievement progress/target, mirrors MAX_HIGHSCORE_VALUE.
const MAX_ACHIEVEMENT_PROGRESS_VALUE = 100_000_000;

// --- UGC LEVELS ---
const MAX_LEVEL_TITLE_LENGTH = 100;
// Generous but bounded - a level is typically bigger than a save blob but still just data.
const MAX_LEVEL_JSON_LENGTH = 300_000;
const MAX_LEVELS_PER_USER_PER_GAME = 200;
const LEVELS_PAGE_SIZE_DEFAULT = 20;
const LEVELS_PAGE_SIZE_MAX = 50;

// --- ICON UPLOAD ---
const ALLOWED_ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];
const MAX_ICON_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

// --- GAME ZIP UPLOAD: SAFETY LIMITS ---
// adm-zip (0.6.1+) already caps a single entry's decompression output at that entry's own
// declared uncompressed size, which blocks the classic "lies about its size" zip-bomb CVE class.
// It does NOT stop an entry that *honestly* declares a huge uncompressed size (trivially achieved
// with a small amount of highly-repetitive data) or a zip with a huge number of entries - both of
// those are plain resource-exhaustion, so they're bounded explicitly here before anything is
// decompressed or uploaded.
const MAX_GAME_ZIP_SIZE_BYTES = 150 * 1024 * 1024; // 150MB - the uploaded .zip itself, compressed
const MAX_UNCOMPRESSED_ENTRY_SIZE_BYTES = 200 * 1024 * 1024; // 200MB - any single file inside it
const MAX_TOTAL_UNCOMPRESSED_SIZE_BYTES = 500 * 1024 * 1024; // 500MB - sum of all files inside it
const MAX_GAME_ZIP_ENTRY_COUNT = 2000; // files + directories combined

// --- ANTI-CHEAT: per-session signed highscore submissions ---
const SESSION_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const SESSION_TIMESTAMP_SKEW_MS = 2 * 60 * 1000; // 2 minutes
// A submission claiming to come from a session that only just started can't reflect real play.
const MIN_SESSION_AGE_MS = 1_500;
// Cooldown between accepted submissions from the same session, to stop someone script-probing
// many candidate scores in rapid succession to find one that slips under the anomaly threshold.
const MIN_SUBMIT_INTERVAL_MS = 2_000;
const HEX_PATTERN = /^[0-9a-f]+$/i;

// --- PLAYTIME ---
// A single ping can only move the total forward by this much, regardless of what the client
// claims - the player page pings roughly every 30s of visible playtime, so this just needs enough
// headroom for a throttled background tab to catch up, not to trust the client's own clock.
const MAX_PLAYTIME_PING_MS = 2 * 60 * 1000;

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

// --- HELPER: VALIDATE AN UPLOADED GAME ZIP BEFORE TOUCHING STORAGE ---
// Reads only the zip's central-directory metadata (entry count, names, declared sizes) - none of
// this decompresses anything, so it's cheap to run as a precheck before the real upload/update
// work (which does decompress each entry via entry.getData()).
type ZipValidationResult = { success: true } | { success: false; code: string; message: string };

function validateGameZip(zip: AdmZip): ZipValidationResult {
	const entries = zip.getEntries();

	if (entries.length > MAX_GAME_ZIP_ENTRY_COUNT) {
		return {
			success: false,
			code: "TOO_MANY_FILES",
			message: `ZIP contains too many files (max ${MAX_GAME_ZIP_ENTRY_COUNT}).`
		};
	}

	let totalUncompressedSize = 0;

	for (const entry of entries) {
		if (entry.isDirectory) continue;

		// adm-zip normalizes entryName to forward slashes, but never strips ".." segments or a
		// leading slash - reject those outright rather than letting attacker-controlled path
		// segments reach an S3 key unchecked.
		if (
			entry.entryName.startsWith("/") ||
			entry.entryName.startsWith("\\") ||
			entry.entryName.split(/[/\\]/).includes("..")
		) {
			return {
				success: false,
				code: "UNSAFE_ENTRY_NAME",
				message: `Unsafe file path in ZIP: ${entry.entryName}`
			};
		}

		const declaredSize = entry.header.size;

		if (declaredSize > MAX_UNCOMPRESSED_ENTRY_SIZE_BYTES) {
			return {
				success: false,
				code: "FILE_TOO_LARGE",
				message: `File too large in ZIP: ${entry.entryName}`
			};
		}

		totalUncompressedSize += declaredSize;

		if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE_BYTES) {
			return {
				success: false,
				code: "ZIP_TOO_LARGE_UNCOMPRESSED",
				message: "ZIP's uncompressed contents are too large."
			};
		}
	}

	return { success: true };
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
	if (
		session.lastSignedTimestamp > 0 &&
		timestamp - session.lastSignedTimestamp < MIN_SUBMIT_INTERVAL_MS
	) {
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

// --- INJECT THE DAVIDNET GAME SDK INTO AN index.html (and any other .html file) ---
// Shared between the initial upload and the in-place update route - keep in sync everywhere else
// the game's HTML is rewritten. Injects two scripts right after <head> (or at the very top if
// there's no <head> tag): a localStorage/sessionStorage polyfill (games run in an opaque-origin
// iframe where real storage isn't available) and window.DavidnetSDK, which bridges to the parent
// player page via postMessage for everything that needs the player's authenticated session
// (highscores, saves, achievements, UGC levels, realtime).
function injectGameSdk(gameId: string, htmlContent: string): string {
	// Safe in-memory storage mock that prevents the game from crashing.
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

	// SDK bridge: exposes window.DavidnetSDK.{applyHighscore,getHighscores,saveJsonBlob,getJsonBlob,
	// unlockAchievement,getAchievements,ugc.*,realtime.*} by round-tripping postMessage calls through
	// the parent player page, which holds the authenticated session the sandboxed iframe can never
	// access directly.
	//
	// Anti-cheat: a per-session secret is fetched once from the server via "startSession" and
	// kept only in this closure (never attached to window.DavidnetSDK). applyHighscore, saveJsonBlob
	// and unlockAchievement sign every submission with it (HMAC-SHA256), so these can only be forged
	// by code that runs inside this exact iframe session - not by postMessage calls crafted from the
	// parent page's own devtools console using the secret-less global SDK object. UGC levels and
	// realtime aren't signed - they aren't anti-cheat surfaces, just authenticated player actions.
	const gameSdkScript = `
                <script>
                    (function() {
                        try {
                            var DN_SOURCE = "davidnet-game-sdk";
                            var GAME_ID = "${gameId}";
                            var pending = {};

                            // Updated from the "rateLimit" field every SDK-backed call's response carries (see
                            // getRateLimitStatus below) - lets a game check its remaining budget and back off
                            // on its own BEFORE actually getting rate-limited, with no extra network round trip.
                            var lastRateLimitStatus = null;

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
                                            if (message.data && message.data.rateLimit) {
                                                lastRateLimitStatus = message.data.rateLimit;
                                            }
                                            resolve(message.data);
                                        } else {
                                            // The bridge's own fetch layer intercepts HTTP 429 before the real
                                            // response body (with its precise resetAt) ever reaches here, so this
                                            // is a best-effort "you're at zero" marker, not an exact reset time.
                                            if (message.error === "RATELIMIT") {
                                                lastRateLimitStatus = {
                                                    limit: lastRateLimitStatus ? lastRateLimitStatus.limit : null,
                                                    remaining: 0,
                                                    resetAt: null
                                                };
                                            }
                                            reject(new Error(message.error || "DavidnetSDK: unknown error"));
                                        }
                                    };

                                    window.parent.postMessage(
                                        { source: DN_SOURCE, type: type, requestId: requestId, payload: payload },
                                        "*"
                                    );
                                });
                            }

                            var realtimeListeners = { message: [], presence: [], matched: [], state: [], announcement: [], disconnect: [], reconnect: [], error: [] };

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
                                // Every call above (except realtime.*, which has its own separate limit) shares
                                // ONE rate-limit budget per player per game. This returns the most recently seen
                                // status WITHOUT making a network call - null until the first call resolves.
                                // Returns: { limit, remaining, resetAt } | null
                                // "resetAt" is an epoch-ms timestamp for when the budget refills, or null if
                                // not yet known (right after actually getting rate-limited, before any further
                                // successful call). Check "remaining" and slow down once it gets low, instead of
                                // waiting to get rejected.
                                getRateLimitStatus: function() {
                                    return lastRateLimitStatus;
                                },
                                // Submit a score. Server keeps the best score per-player and globally, PER
                                // CATEGORY - pass { category: "time-attack" } to use a leaderboard other than
                                // the default one (omit it entirely and you get the one-leaderboard-per-game
                                // behavior games have always had).
                                // Resolves: { score, playerHighscore, globalHighscore, isNewPersonalBest, isNewGlobalBest }
                                applyHighscore: function(score, options) {
                                    var category = (options && options.category) || "default";
                                    return sessionReady.then(function(session) {
                                        var timestamp = Date.now();
                                        var message = session.sessionId + ":" + GAME_ID + ":" + score + ":" + timestamp;
                                        return signMessage(session.secret, message).then(function(signature) {
                                            return call("applyHighscore", {
                                                score: score,
                                                category: category,
                                                sessionId: session.sessionId,
                                                timestamp: timestamp,
                                                signature: signature
                                            });
                                        });
                                    });
                                },
                                // Pass { category: "time-attack" } to read a non-default leaderboard.
                                // Resolves: { playerHighscore, globalHighscore, leaderboard: [{ rank, username, displayName, avatarUrl, score }] (top 10) }
                                getHighscores: function(options) {
                                    var category = (options && options.category) || "default";
                                    return call("getHighscores", { category: category });
                                },
                                // Persist an arbitrary JSON-serializable save object (max ~1MB) in a named
                                // save slot. Pass { slot: "hardcore" } to use a slot other than the default
                                // one - omit it entirely and you get the classic one-save-per-player
                                // behavior, fully backwards compatible with every game uploaded before
                                // slots existed. Resolves: { savedAt }
                                saveJsonBlob: function(data, options) {
                                    var slot = (options && options.slot) || "default";
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
                                                        slot: slot,
                                                        sessionId: session.sessionId,
                                                        timestamp: timestamp,
                                                        signature: signature
                                                    });
                                                });
                                            });
                                    });
                                },
                                // Pass { slot: "hardcore" } to read a non-default save slot.
                                // Resolves: { data, updatedAt } — data is null if nothing was saved in that slot yet.
                                getJsonBlob: function(options) {
                                    var slot = (options && options.slot) || "default";
                                    return call("getJsonBlob", { slot: slot });
                                },

                                // Unlock (or advance) an achievement for the current player. achievement is
                                // { id, name, description?, icon?, progress?, target? } - "id" is a stable
                                // string you choose (unique within your game, not globally).
                                //
                                // Without progress/target: classic instant unlock - first call wins, repeat
                                // calls are cheap no-ops server-side, name/description/icon don't change after
                                // the first call. Still, call this ONCE when the condition first becomes true,
                                // not every frame it stays true - each call counts against the SDK rate limit.
                                //
                                // With progress + target (both positive integers): tracks a progress bar
                                // instead of unlocking instantly - call this every time progress changes
                                // (e.g. "12 of 50 enemies defeated"). The server remembers the HIGHEST
                                // progress seen; "isNew" only flips true the moment progress reaches target
                                // (the achievement completes), after which it's immutable like a classic
                                // achievement. getAchievements() includes in-progress achievements too
                                // (unlockedAt: null) so you can rebuild a progress bar on load.
                                // Resolves: { isNew, achievement: { id, name, description, icon, progress, target, unlockedAt } }
                                unlockAchievement: function(achievement) {
                                    achievement = achievement || {};
                                    var id = String(achievement.id || "");
                                    var name = String(achievement.name || id);
                                    var description = achievement.description != null ? String(achievement.description) : null;
                                    var icon = achievement.icon != null ? String(achievement.icon) : null;
                                    var progress = achievement.progress != null ? Number(achievement.progress) : null;
                                    var target = achievement.target != null ? Number(achievement.target) : null;
                                    return sessionReady.then(function(session) {
                                        var serialized = JSON.stringify({ id: id, name: name, description: description, icon: icon, progress: progress, target: target });
                                        var timestamp = Date.now();
                                        var enc = new TextEncoder();
                                        return crypto.subtle.digest("SHA-256", enc.encode(serialized))
                                            .then(hexFromBuffer)
                                            .then(function(dataHash) {
                                                var message = session.sessionId + ":" + GAME_ID + ":" + dataHash + ":" + timestamp;
                                                return signMessage(session.secret, message).then(function(signature) {
                                                    return call("unlockAchievement", {
                                                        id: id,
                                                        name: name,
                                                        description: description,
                                                        icon: icon,
                                                        progress: progress,
                                                        target: target,
                                                        sessionId: session.sessionId,
                                                        timestamp: timestamp,
                                                        signature: signature
                                                    });
                                                });
                                            });
                                    });
                                },
                                // Resolves: { achievements: [{ id, name, description, icon, progress, target,
                                // unlockedAt, unlockedPercentage }] } — every achievement this player has
                                // unlocked OR made progress on in THIS game. unlockedAt is null for an
                                // in-progress (not yet completed) achievement. unlockedPercentage (0-100) is
                                // the share of players who have fully unlocked that achievement id, handy
                                // for a rarity badge ("3% of players have this").
                                getAchievements: function() {
                                    return call("getAchievements", {});
                                },

                                // Community/UGC levels: a generic level-upload system. Level data is an
                                // opaque JSON blob - the platform never looks inside it, so it works for any
                                // level/map/track format your game defines. Levels are public once
                                // published: any player can list and download them, same trust model as the
                                // rest of this sandboxed game (your game decides what to publish).
                                ugc: {
                                    // Publishes a new level, or - if you pass the "id" of a level you own -
                                    // overwrites it in place (e.g. after the player edits it further).
                                    // Resolves: { id, title, createdAt, updatedAt }
                                    publishLevel: function(level) {
                                        level = level || {};
                                        return call("ugcPublishLevel", {
                                            id: level.id || undefined,
                                            title: String(level.title || ""),
                                            data: level.data
                                        });
                                    },
                                    // Lists published levels for this game, newest first. Pass { mine: true }
                                    // to list only your own, { limit, offset } to page through them (limit
                                    // defaults to 20, max 50). Does NOT include the level data itself - call
                                    // getLevel once the player picks one.
                                    // Resolves: { levels: [{ id, title, creator, creatorDisplayName, createdAt, updatedAt }], hasMore }
                                    listLevels: function(options) {
                                        options = options || {};
                                        return call("ugcListLevels", {
                                            mine: !!options.mine,
                                            limit: options.limit,
                                            offset: options.offset
                                        });
                                    },
                                    // Resolves: { id, title, data, creator, creatorDisplayName, createdAt, updatedAt }
                                    getLevel: function(id) {
                                        return call("ugcGetLevel", { id: String(id || "") });
                                    },
                                    // Deletes a level you published (or any level, if you're the game's
                                    // creator). Resolves: { id }
                                    deleteLevel: function(id) {
                                        return call("ugcDeleteLevel", { id: String(id || "") });
                                    }
                                },

                                // Generic real-time extension: rooms (pub/sub channels with presence), a
                                // matchmaking queue, a per-room state channel, and a lobby-wide announcement
                                // channel. Content-agnostic - the platform never inspects "data"/"value", so
                                // the same primitives work for a 2-player board game, a 50+ player shooter,
                                // or a one-way live feed (e.g. a price ticker) with no "match" concept at
                                // all. There is no maximum room size, queue size, or group size.
                                realtime: {
                                    // Opens the realtime connection. Called automatically by every other
                                    // realtime.* method, so you only need this if you want to connect early.
                                    connect: function() {
                                        return call("realtimeConnect", {});
                                    },
                                    // Joins a named room (created on first join, destroyed when empty). You
                                    // can join any number of rooms. Resolves: { room, members, state } -
                                    // members is everyone already in the room, state is a snapshot of every
                                    // key/value set in this room so far via setState (see below).
                                    joinRoom: function(room) {
                                        return call("realtimeJoinRoom", { room: room });
                                    },
                                    // Resolves: { room }
                                    leaveRoom: function(room) {
                                        return call("realtimeLeaveRoom", { room: room });
                                    },
                                    // Checks how many members are currently in a room WITHOUT joining it -
                                    // e.g. to show "3/8 players" on a lobby list before committing to join.
                                    // Resolves: { room, memberCount, members }
                                    getRoomInfo: function(room) {
                                        return call("realtimeRoomInfo", { room: room });
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
                                    // Sets a named key's value for everyone in the room: the server remembers
                                    // the LATEST value per key and hands the full set back as "state" to
                                    // anyone who joins afterwards (see joinRoom), plus pushes a live "state"
                                    // event to everyone else already in the room. Useful for anything a late
                                    // joiner needs to catch up on - player positions, ready/not-ready status,
                                    // a shared scoreboard - in any realtime game, not just shooters. You must
                                    // be joined to the room first. Resolves: { room, key }
                                    setState: function(room, key, value) {
                                        return call("realtimeSetState", { room: room, key: key, value: value });
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
                                    // Checks how many players are currently waiting in a queue WITHOUT
                                    // joining it - e.g. to show "waiting for 2 more players" up front.
                                    // Resolves: { queue, waiting }
                                    getQueueInfo: function(queue) {
                                        return call("realtimeQueueInfo", { queue: queue });
                                    },
                                    // Broadcasts to EVERY player currently connected to this game's lobby,
                                    // not just a specific room - for server-wide-feeling announcements (e.g.
                                    // "Player X just beat the boss!") independent of whatever room each
                                    // player is in. Pass { echo: true } to also receive your own announcement
                                    // back. Fire-and-forget - does not wait for delivery. Resolves: {}
                                    announce: function(data, options) {
                                        return call("realtimeAnnounce", {
                                            data: data,
                                            echo: !!(options && options.echo)
                                        });
                                    },
                                    // Fires for every message sent to a room you're in: { room, data, from, ts }.
                                    // Returns an unsubscribe function.
                                    onMessage: function(cb) { return subscribe("message", cb); },
                                    // Fires when someone joins/leaves a room you're in: { room, event, member }.
                                    onPresence: function(cb) { return subscribe("presence", cb); },
                                    // Fires when anyone (including you) calls setState in a room you're in:
                                    // { room, key, value, from }.
                                    onState: function(cb) { return subscribe("state", cb); },
                                    // Fires for every lobby-wide announcement from any connected player of
                                    // this game: { data, from, ts }.
                                    onAnnouncement: function(cb) { return subscribe("announcement", cb); },
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
		return htmlContent.replace(/<head>/i, "<head>\n" + storagePolyfill + gameSdkScript);
	}
	return storagePolyfill + gameSdkScript + htmlContent;
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

	if (file.size > MAX_GAME_ZIP_SIZE_BYTES) {
		return c.json({ success: false, code: "ZIP_TOO_LARGE" }, 400);
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
		const buffer = Buffer.from(await file.arrayBuffer());
		const zip = new AdmZip(buffer);

		const zipValidation = validateGameZip(zip);
		if (!zipValidation.success) {
			return c.json(
				{ success: false, code: zipValidation.code, message: zipValidation.message },
				400
			);
		}

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
				fileData = Buffer.from(injectGameSdk(gameId, fileData.toString("utf-8")), "utf-8");
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
			await uploadToBucket(
				"communitygames",
				`${gameId}/${iconFilename}`,
				iconBuffer,
				iconFile.type
			);
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

		void notifyActivity(
			"🎮 Community game created",
			userId,
			{ "Game ID": newGame.id, Title: newGame.title },
			undefined,
			contentUrlFor("game", newGame.id)
		);

		return c.json({ success: true, code: "GAME_UPLOADED", game: newGame });
	} catch (error) {
		console.error("Failed to upload community game:", error);
		return c.json({ success: false, code: "UPLOAD_FAILED" }, 500);
	}
});

// --- 1B. UPDATE COMMUNITY GAME (files and/or metadata) ---
// Creator-only (same bar as deleting the game). Every field is optional and independent - a
// request can replace just the zip, just the icon, just the title/description/AI-disclosure, or
// any combination. The zip-replace path re-runs the exact same zip validation + SDK injection as
// the initial upload - keep that in sync with "--- 1. UPLOAD COMMUNITY GAME ---" above if that
// logic ever changes.
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
	const file = body["game"] as string | File | undefined;
	const title = body["title"] as string | File | undefined;
	const description = body["description"] as string | File | undefined;
	const iconFile = body["icon"] as string | File | undefined;
	const isAiGeneratedRaw = body["isAiGenerated"] as string | File | undefined;

	if (file !== undefined && !(file instanceof File)) {
		return c.json({ success: false, code: "MISSING_ZIP_FILE" }, 400);
	}

	if (
		file instanceof File &&
		!file.name.endsWith(".zip") &&
		file.type !== "application/zip" &&
		file.type !== "application/x-zip-compressed"
	) {
		return c.json(
			{ success: false, code: "INVALID_FILE_TYPE", message: "Only .zip files are allowed" },
			400
		);
	}

	if (file instanceof File && file.size > MAX_GAME_ZIP_SIZE_BYTES) {
		return c.json({ success: false, code: "ZIP_TOO_LARGE" }, 400);
	}

	if (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) {
		return c.json({ success: false, code: "MISSING_TITLE" }, 400);
	}

	if (description !== undefined && typeof description !== "string") {
		return c.json({ success: false, code: "INVALID_DESCRIPTION" }, 400);
	}

	// New icon filename to persist, or undefined if the icon isn't being changed in this request.
	let newIconFilename: string | undefined = undefined;
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

		newIconFilename = `icon.${iconFile.type.split("/")[1]}`;
	}

	if (
		!(file instanceof File) &&
		title === undefined &&
		description === undefined &&
		newIconFilename === undefined &&
		isAiGeneratedRaw === undefined
	) {
		return c.json({ success: false, code: "NOTHING_TO_UPDATE" }, 400);
	}

	try {
		let hasIndexHtml = false;

		if (file instanceof File) {
			// Validate the zip BEFORE deleting any existing files, so a bad upload can't take down an
			// already-working game.
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

			const zipValidation = validateGameZip(precheckZip);
			if (!zipValidation.success) {
				return c.json(
					{ success: false, code: zipValidation.code, message: zipValidation.message },
					400
				);
			}

			// Remove the previous version's files (except the icon, which is managed separately below)
			// so stale files the new zip doesn't include don't linger and stay servable.
			const existingKeys = await listBucketObjects("communitygames", `${gameId}/`);
			const iconKey = existingGame.iconFilename ? `${gameId}/${existingGame.iconFilename}` : null;
			await deleteFromBucket(
				"communitygames",
				existingKeys.filter((key) => key !== iconKey)
			);

			// Already fully parsed above (and validated) - no need to re-read the file or re-parse it.
			const zip = precheckZip;
			const zipEntries = zip.getEntries();

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
					fileData = Buffer.from(injectGameSdk(gameId, fileData.toString("utf-8")), "utf-8");
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
		}

		// Icon replace: delete the old icon object (its filename/extension may differ from the new
		// one) before uploading the new one, so no orphaned icon file is left behind in the bucket.
		if (newIconFilename !== undefined && iconFile instanceof File) {
			if (existingGame.iconFilename) {
				await deleteFromBucket("communitygames", [`${gameId}/${existingGame.iconFilename}`]);
			}

			const iconBuffer = Buffer.from(await iconFile.arrayBuffer());
			await uploadToBucket(
				"communitygames",
				`${gameId}/${newIconFilename}`,
				iconBuffer,
				iconFile.type
			);
		}

		const updateValues: Partial<typeof communityGame.$inferInsert> = { updatedAt: new Date() };
		if (typeof title === "string") updateValues.title = title.trim();
		if (typeof description === "string") updateValues.description = description.trim() || null;
		if (isAiGeneratedRaw !== undefined) updateValues.isAiGenerated = isAiGeneratedRaw === "true";
		if (newIconFilename !== undefined) updateValues.iconFilename = newIconFilename;

		await database.update(communityGame).set(updateValues).where(eq(communityGame.id, gameId));

		void notifyActivity(
			"🎮 Community game updated",
			userId,
			{ "Game ID": gameId },
			undefined,
			contentUrlFor("game", gameId)
		);

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

// --- 2C. GET MY ACHIEVEMENTS ACROSS ALL COMMUNITY GAMES ---
communityGamesRoute.get("/achievements/mine", requireAuth, async (c) => {
	const userId = c.get("user").id;

	try {
		// Only fully completed achievements - a cross-game trophy case shouldn't mix in half-finished
		// progress bars from games that use progress/target achievements.
		const achievements = await database
			.select({
				gameId: communityGameAchievements.gameId,
				gameTitle: communityGame.title,
				gameIconFilename: communityGame.iconFilename,
				achievementId: communityGameAchievements.achievementId,
				name: communityGameAchievements.name,
				description: communityGameAchievements.description,
				icon: communityGameAchievements.icon,
				unlockedAt: communityGameAchievements.completedAt
			})
			.from(communityGameAchievements)
			.innerJoin(communityGame, eq(communityGameAchievements.gameId, communityGame.id))
			.where(
				and(
					eq(communityGameAchievements.userId, userId),
					isNotNull(communityGameAchievements.completedAt)
				)
			)
			.orderBy(desc(communityGameAchievements.completedAt));

		c.header("Cache-Control", "no-store");
		return c.json({ success: true, code: "SUCCESS", achievements });
	} catch (error) {
		console.error("Failed to fetch achievements:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 2B. GET A SPECIFIC PLAYER'S CROSS-GAME ACHIEVEMENTS (defaults to yourself) ---
// Same shape as /achievements/mine, but for any player - used by the account app's profile page
// to show someone else's trophy case. Gated by that player's achievementsVisibility privacy
// preference (same visibilityEnum as language/timezone/etc, defaults to "public"); only "public"
// counts as viewable by someone else, matching the canView convention in /auth/profile. Viewing
// your own is always allowed regardless of it.
communityGamesRoute.get("/achievements", collectAuth, async (c) => {
	const requestingUserId = c.get("user")?.id;
	const targetUserId = c.req.query("user") ?? requestingUserId;

	if (!targetUserId) {
		return c.json({ success: false, code: "MISSING_USER" }, 400);
	}

	const isOwn = requestingUserId === targetUserId;

	try {
		if (!isOwn) {
			const [privacy] = await database
				.select({ achievementsVisibility: userPrivacyPreferences.achievementsVisibility })
				.from(userPrivacyPreferences)
				.where(eq(userPrivacyPreferences.userId, targetUserId))
				.limit(1);

			// Fail open (visible) if the row is somehow missing rather than erroring out.
			if (privacy && privacy.achievementsVisibility !== "public") {
				c.header("Cache-Control", "no-store");
				return c.json({ success: true, code: "SUCCESS", visible: false, achievements: [] });
			}
		}

		const achievements = await database
			.select({
				gameId: communityGameAchievements.gameId,
				gameTitle: communityGame.title,
				gameIconFilename: communityGame.iconFilename,
				achievementId: communityGameAchievements.achievementId,
				name: communityGameAchievements.name,
				description: communityGameAchievements.description,
				icon: communityGameAchievements.icon,
				unlockedAt: communityGameAchievements.completedAt
			})
			.from(communityGameAchievements)
			.innerJoin(communityGame, eq(communityGameAchievements.gameId, communityGame.id))
			.where(
				and(
					eq(communityGameAchievements.userId, targetUserId),
					isNotNull(communityGameAchievements.completedAt)
				)
			)
			.orderBy(desc(communityGameAchievements.completedAt));

		c.header("Cache-Control", "no-store");
		return c.json({ success: true, code: "SUCCESS", visible: true, achievements });
	} catch (error) {
		console.error("Failed to fetch achievements:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 2C. GET MY TOTAL PLAYTIME ACROSS ALL COMMUNITY GAMES ---
communityGamesRoute.get("/playtime/total", requireAuth, async (c) => {
	const userId = c.get("user").id;

	try {
		const rows = await database
			.select({
				gameId: communityGamePlaytime.gameId,
				gameTitle: communityGame.title,
				gameIconFilename: communityGame.iconFilename,
				totalPlaytimeMs: communityGamePlaytime.totalPlaytimeMs
			})
			.from(communityGamePlaytime)
			.innerJoin(communityGame, eq(communityGamePlaytime.gameId, communityGame.id))
			.where(eq(communityGamePlaytime.userId, userId))
			.orderBy(desc(communityGamePlaytime.totalPlaytimeMs));

		const totalPlaytimeMs = rows.reduce((sum, row) => sum + row.totalPlaytimeMs, 0);

		c.header("Cache-Control", "no-store");
		return c.json({ success: true, code: "SUCCESS", totalPlaytimeMs, games: rows });
	} catch (error) {
		console.error("Failed to fetch total playtime:", error);
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

		void notifyActivity("🗑️ Community game deleted", userId, {
			"Game ID": gameId,
			Title: game.title
		});

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
				updatedAt: communityGame.updatedAt,
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

		void notifyActivity(
			"🎮 Community game moderated",
			moderatorId,
			{ "Game ID": updatedGame.id, Hidden: body.isModerated ? "Yes" : "No" },
			updatedGame.userId,
			contentUrlFor("game", updatedGame.id)
		);

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
communityGamesRoute.post("/:id/session/start", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));

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
			expiresAt: session.expiresAt,
			rateLimit
		});
	} catch (error) {
		console.error("Failed to start game session:", error);
		return c.json({ success: false, code: "SESSION_START_FAILED" }, 500);
	}
});

// --- 9. APPLY HIGHSCORE ---
communityGamesRoute.post("/:id/highscore", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
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

	// Not part of the signed payload (see sanitizeCategory's definition) - it's just a label used to
	// bucket scores into separate leaderboards, with no stronger anti-cheat requirement than the
	// score itself already has. Keeping it out of the signature means old, already-uploaded games
	// (whose injected script never sends a category) keep verifying exactly as before.
	const category = sanitizeCategory(body.category);
	if (category === null) {
		return c.json({ success: false, code: "INVALID_CATEGORY" }, 400);
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
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.category, category),
					eq(communityGameHighscores.flagged, false)
				)
			)
			.orderBy(desc(communityGameHighscores.score))
			.limit(1);

		const [{ sampleSize }] = await database
			.select({ sampleSize: sql<number>`count(*)::int` })
			.from(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.category, category),
					eq(communityGameHighscores.flagged, false)
				)
			);

		const [existing] = await database
			.select({ score: communityGameHighscores.score, flagged: communityGameHighscores.flagged })
			.from(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, user.id),
					eq(communityGameHighscores.category, category)
				)
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
					category,
					score,
					flagged: isAnomalous,
					flagReason: isAnomalous
						? `Score is more than ${ANOMALY_SCORE_MULTIPLIER}x the current leaderboard top (${prevGlobalTop!.score}).`
						: null
				})
				.onConflictDoUpdate({
					target: [
						communityGameHighscores.gameId,
						communityGameHighscores.userId,
						communityGameHighscores.category
					],
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
		const isNewGlobalBest =
			!isAnomalous && (!prevGlobalTop || playerHighscore > prevGlobalTop.score);
		const globalHighscore = isNewGlobalBest
			? playerHighscore
			: (prevGlobalTop?.score ?? playerHighscore);

		return c.json({
			success: true,
			code: "SUCCESS",
			score,
			category,
			playerHighscore,
			playerHighscoreFlagged,
			globalHighscore,
			isNewPersonalBest,
			isNewGlobalBest,
			rateLimit
		});
	} catch (error) {
		console.error("Failed to apply highscore:", error);
		return c.json({ success: false, code: "HIGHSCORE_FAILED" }, 500);
	}
});

// --- 9B. LIST A GAME'S LEADERBOARD CATEGORIES ---
// Lets a player page (or the game itself) discover what leaderboards exist for a game, since
// categories are created ad hoc by whatever the game submits - there's no upfront catalog.
communityGamesRoute.get("/:id/highscores/categories", requireAuth, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");

	try {
		const categories = await database
			.selectDistinct({ category: communityGameHighscores.category })
			.from(communityGameHighscores)
			.where(eq(communityGameHighscores.gameId, gameId))
			.orderBy(communityGameHighscores.category);

		c.header("Cache-Control", "no-store");
		return c.json({
			success: true,
			code: "SUCCESS",
			categories: categories.map((c) => c.category)
		});
	} catch (error) {
		console.error("Failed to fetch leaderboard categories:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 10. GET HIGHSCORES (own + global leaderboard top 10, for one category) ---
communityGamesRoute.get("/:id/highscores", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	const category = sanitizeCategory(c.req.query("category"));
	if (category === null) {
		return c.json({ success: false, code: "INVALID_CATEGORY" }, 400);
	}

	try {
		// Flagged scores are under review and excluded from everyone's public leaderboard view.
		// Players whose leaderboardVisibility isn't "public" are excluded too (their own score below
		// is unaffected - that setting only controls whether OTHERS see them on the list).
		const leaderboard = await database
			.select({
				userId: communityGameHighscores.userId,
				score: communityGameHighscores.score,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				language: userPreferences.language,
				languageVisibility: userPrivacyPreferences.languageVisibility,
				playtimeMs: communityGamePlaytime.totalPlaytimeMs
			})
			.from(communityGameHighscores)
			.innerJoin(users, eq(communityGameHighscores.userId, users.userId))
			.leftJoin(userPreferences, eq(communityGameHighscores.userId, userPreferences.userId))
			.leftJoin(
				userPrivacyPreferences,
				eq(communityGameHighscores.userId, userPrivacyPreferences.userId)
			)
			.leftJoin(
				communityGamePlaytime,
				and(
					eq(communityGamePlaytime.gameId, gameId),
					eq(communityGamePlaytime.userId, communityGameHighscores.userId)
				)
			)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.category, category),
					eq(communityGameHighscores.flagged, false),
					// Fail open (visible) if the privacy row is somehow missing.
					sql`coalesce(${userPrivacyPreferences.leaderboardVisibility}, 'public') = 'public'`
				)
			)
			.orderBy(desc(communityGameHighscores.score))
			.limit(10);

		const [own] = await database
			.select({ score: communityGameHighscores.score, flagged: communityGameHighscores.flagged })
			.from(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, user.id),
					eq(communityGameHighscores.category, category)
				)
			)
			.limit(1);

		const rankedLeaderboard = leaderboard.map(({ languageVisibility, ...row }, index) => ({
			...row,
			rank: index + 1,
			language: languageVisibility === "public" ? row.language : null,
			playtimeMs: row.playtimeMs ?? 0
		}));

		c.header("Cache-Control", "no-store");
		return c.json({
			success: true,
			code: "SUCCESS",
			category,
			playerHighscore: own?.score ?? null,
			playerHighscoreFlagged: own?.flagged ?? false,
			globalHighscore: rankedLeaderboard[0] ?? null,
			leaderboard: rankedLeaderboard,
			rateLimit
		});
	} catch (error) {
		console.error("Failed to fetch highscores:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 10B. ADD PLAYTIME (own total for one game) ---
// Called periodically by the player page while the game's iframe is visible, reporting the
// elapsed ms since its last ping. There is no session end/start pair for this - just small,
// clamped increments, so a tab close loses at most one ping interval of playtime.
communityGamesRoute.post("/:id/playtime/ping", requireAuth, async (c) => {
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

	const deltaMs = Number(body.deltaMs);
	if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
		return c.json({ success: false, code: "INVALID_DELTA" }, 400);
	}
	const clampedDelta = Math.min(deltaMs, MAX_PLAYTIME_PING_MS);

	try {
		const [game] = await database
			.select({ id: communityGame.id })
			.from(communityGame)
			.where(eq(communityGame.id, gameId))
			.limit(1);

		if (!game) return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);

		const [row] = await database
			.insert(communityGamePlaytime)
			.values({ gameId, userId: user.id, totalPlaytimeMs: clampedDelta })
			.onConflictDoUpdate({
				target: [communityGamePlaytime.gameId, communityGamePlaytime.userId],
				set: {
					totalPlaytimeMs: sql`${communityGamePlaytime.totalPlaytimeMs} + ${clampedDelta}`,
					updatedAt: new Date()
				}
			})
			.returning({ totalPlaytimeMs: communityGamePlaytime.totalPlaytimeMs });

		c.header("Cache-Control", "no-store");
		return c.json({ success: true, code: "SUCCESS", totalPlaytimeMs: row.totalPlaytimeMs });
	} catch (error) {
		console.error("Failed to add playtime:", error);
		return c.json({ success: false, code: "PLAYTIME_FAILED" }, 500);
	}
});

// --- 10C. GET MY PLAYTIME FOR ONE GAME ---
communityGamesRoute.get("/:id/playtime", requireAuth, async (c) => {
	const user = c.get("user");
	const gameId = c.req.param("id");

	try {
		const [row] = await database
			.select({ totalPlaytimeMs: communityGamePlaytime.totalPlaytimeMs })
			.from(communityGamePlaytime)
			.where(
				and(eq(communityGamePlaytime.gameId, gameId), eq(communityGamePlaytime.userId, user.id))
			)
			.limit(1);

		c.header("Cache-Control", "no-store");
		return c.json({ success: true, code: "SUCCESS", totalPlaytimeMs: row?.totalPlaytimeMs ?? 0 });
	} catch (error) {
		console.error("Failed to fetch playtime:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 11. SAVE JSON BLOB (own save) ---
communityGamesRoute.post("/:id/save", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	if (body.data === undefined) {
		return c.json({ success: false, code: "MISSING_DATA" }, 400);
	}

	const slot = sanitizeSlot(body.slot);
	if (slot === null) {
		return c.json({ success: false, code: "INVALID_SLOT" }, 400);
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
			.values({ gameId, userId: user.id, slot, data: body.data, updatedAt: now })
			.onConflictDoUpdate({
				target: [communityGameSaves.gameId, communityGameSaves.userId, communityGameSaves.slot],
				set: { data: body.data, updatedAt: now }
			});

		return c.json({ success: true, code: "SUCCESS", slot, savedAt: now, rateLimit });
	} catch (error) {
		console.error("Failed to save json blob:", error);
		return c.json({ success: false, code: "SAVE_FAILED" }, 500);
	}
});

// --- 12. GET JSON BLOB (own save) ---
communityGamesRoute.get("/:id/save", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	const slot = sanitizeSlot(c.req.query("slot"));
	if (slot === null) {
		return c.json({ success: false, code: "INVALID_SLOT" }, 400);
	}

	try {
		const [save] = await database
			.select({ data: communityGameSaves.data, updatedAt: communityGameSaves.updatedAt })
			.from(communityGameSaves)
			.where(
				and(
					eq(communityGameSaves.gameId, gameId),
					eq(communityGameSaves.userId, user.id),
					eq(communityGameSaves.slot, slot)
				)
			)
			.limit(1);

		return c.json({
			success: true,
			code: "SUCCESS",
			slot,
			data: save?.data ?? null,
			updatedAt: save?.updatedAt ?? null,
			rateLimit
		});
	} catch (error) {
		console.error("Failed to fetch json blob:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 13. WIPE OWN SAVE ---
// Wipes ALL save slots for this player/game in one go - a game with multiple slots doesn't get
// multiple "wipe" buttons, this is a full reset.
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

// --- 13B. UNLOCK ACHIEVEMENT ---
communityGamesRoute.post("/:id/achievement", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const achievementId = typeof body.id === "string" ? body.id : "";
	if (
		achievementId.length === 0 ||
		achievementId.length > MAX_ACHIEVEMENT_ID_LENGTH ||
		!ACHIEVEMENT_ID_PATTERN.test(achievementId)
	) {
		return c.json({ success: false, code: "INVALID_ACHIEVEMENT_ID" }, 400);
	}

	const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : achievementId;
	if (name.length > MAX_ACHIEVEMENT_NAME_LENGTH) {
		return c.json({ success: false, code: "INVALID_ACHIEVEMENT_NAME" }, 400);
	}

	const description =
		body.description === undefined || body.description === null ? null : String(body.description);
	if (description !== null && description.length > MAX_ACHIEVEMENT_DESCRIPTION_LENGTH) {
		return c.json({ success: false, code: "INVALID_ACHIEVEMENT_DESCRIPTION" }, 400);
	}

	const icon = body.icon === undefined || body.icon === null ? null : String(body.icon);
	if (icon !== null && icon.length > MAX_ACHIEVEMENT_ICON_LENGTH) {
		return c.json({ success: false, code: "INVALID_ACHIEVEMENT_ICON" }, 400);
	}

	// Progress/target: omitting both means a classic instant-unlock achievement. They only make
	// sense together, so passing just one of them is rejected.
	const hasProgressInput = body.progress !== undefined && body.progress !== null;
	const hasTargetInput = body.target !== undefined && body.target !== null;
	if (hasProgressInput !== hasTargetInput) {
		return c.json({ success: false, code: "INVALID_ACHIEVEMENT_PROGRESS" }, 400);
	}

	let progress: number | null = null;
	let target: number | null = null;
	if (hasProgressInput && hasTargetInput) {
		target = Number(body.target);
		progress = Number(body.progress);
		if (!Number.isInteger(target) || target < 1 || target > MAX_ACHIEVEMENT_PROGRESS_VALUE) {
			return c.json({ success: false, code: "INVALID_ACHIEVEMENT_TARGET" }, 400);
		}
		if (!Number.isInteger(progress) || progress < 0) {
			return c.json({ success: false, code: "INVALID_ACHIEVEMENT_PROGRESS" }, 400);
		}
		progress = Math.min(progress, target);
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

	// Sign over the same shape the injected SDK script hashed client-side.
	const payloadHash = createHash("sha256")
		.update(JSON.stringify({ id: achievementId, name, description, icon, progress, target }))
		.digest("hex");

	const sessionCheck = await verifyGameSession({
		sessionId,
		gameId,
		userId: user.id,
		payload: payloadHash,
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
		// A classic achievement (no target) completes the instant it's created; a progress
		// achievement only completes once progress has already reached target on this very call.
		const completesOnInsert = target === null || (progress !== null && progress >= target);

		// First call wins the metadata (name/description/icon) and creates the row - a repeat call
		// either advances progress (if still in progress) or is a cheap no-op (if already completed).
		const inserted = await database
			.insert(communityGameAchievements)
			.values({
				gameId,
				userId: user.id,
				achievementId,
				name,
				description,
				icon,
				progress,
				target,
				unlockedAt: now,
				completedAt: completesOnInsert ? now : null
			})
			.onConflictDoNothing({
				target: [
					communityGameAchievements.gameId,
					communityGameAchievements.userId,
					communityGameAchievements.achievementId
				]
			})
			.returning();

		let achievement = inserted[0];
		let isNew = Boolean(achievement) && completesOnInsert;

		if (!achievement) {
			const [existing] = await database
				.select()
				.from(communityGameAchievements)
				.where(
					and(
						eq(communityGameAchievements.gameId, gameId),
						eq(communityGameAchievements.userId, user.id),
						eq(communityGameAchievements.achievementId, achievementId)
					)
				)
				.limit(1);

			achievement = existing;

			// Once completed, an achievement is immutable - this mirrors the "first unlock wins"
			// guarantee a classic achievement already had. Only advance progress while still open.
			if (achievement && !achievement.completedAt && progress !== null && target !== null) {
				const newProgress = Math.max(achievement.progress ?? 0, progress);
				const completing = newProgress >= target;

				const [updated] = await database
					.update(communityGameAchievements)
					.set({ progress: newProgress, target, completedAt: completing ? now : null })
					.where(
						and(
							eq(communityGameAchievements.gameId, gameId),
							eq(communityGameAchievements.userId, user.id),
							eq(communityGameAchievements.achievementId, achievementId)
						)
					)
					.returning();

				achievement = updated;
				isNew = completing;
			}
		}

		return c.json({
			success: true,
			code: "SUCCESS",
			isNew,
			achievement: {
				id: achievement.achievementId,
				name: achievement.name,
				description: achievement.description,
				icon: achievement.icon,
				progress: achievement.progress,
				target: achievement.target,
				unlockedAt: achievement.completedAt
			},
			rateLimit
		});
	} catch (error) {
		console.error("Failed to unlock achievement:", error);
		return c.json({ success: false, code: "UNLOCK_FAILED" }, 500);
	}
});

// --- 13C. GET MY ACHIEVEMENTS FOR ONE GAME ---
communityGamesRoute.get("/:id/achievements", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));

	try {
		// Includes in-progress (not yet completed) achievements too, so a game can rebuild a
		// progress bar on load - "unlockedAt" is null for those. unlockedAt here is completedAt,
		// not the row's creation time (see the schema comment on completedAt).
		const rows = await database
			.select({
				id: communityGameAchievements.achievementId,
				name: communityGameAchievements.name,
				description: communityGameAchievements.description,
				icon: communityGameAchievements.icon,
				progress: communityGameAchievements.progress,
				target: communityGameAchievements.target,
				unlockedAt: communityGameAchievements.completedAt
			})
			.from(communityGameAchievements)
			.where(
				and(
					eq(communityGameAchievements.gameId, gameId),
					eq(communityGameAchievements.userId, user.id)
				)
			)
			.orderBy(desc(communityGameAchievements.unlockedAt));

		if (rows.length === 0) {
			return c.json({ success: true, code: "SUCCESS", achievements: [] });
		}

		// Rarity: the share of players (0-100) who have fully unlocked each achievement id, out of
		// everyone who has ever started a play session for this game - a reasonable proxy for
		// "played", and already tracked for anti-cheat sessions.
		const achievementIds = Array.from(new Set(rows.map((row) => row.id)));

		const [totalPlayersRow] = await database
			.select({ totalPlayers: sql<number>`count(distinct ${communityGameSessions.userId})::int` })
			.from(communityGameSessions)
			.where(eq(communityGameSessions.gameId, gameId));
		const totalPlayers = totalPlayersRow?.totalPlayers ?? 0;

		const unlockCounts = await database
			.select({
				achievementId: communityGameAchievements.achievementId,
				unlockers: sql<number>`count(distinct ${communityGameAchievements.userId})::int`
			})
			.from(communityGameAchievements)
			.where(
				and(
					eq(communityGameAchievements.gameId, gameId),
					inArray(communityGameAchievements.achievementId, achievementIds),
					isNotNull(communityGameAchievements.completedAt)
				)
			)
			.groupBy(communityGameAchievements.achievementId);
		const unlockersById = new Map(unlockCounts.map((row) => [row.achievementId, row.unlockers]));

		const achievements = rows.map((row) => ({
			...row,
			unlockedPercentage:
				totalPlayers > 0
					? Math.min(100, Math.round(((unlockersById.get(row.id) ?? 0) / totalPlayers) * 100))
					: 0
		}));

		return c.json({ success: true, code: "SUCCESS", achievements });
	} catch (error) {
		console.error("Failed to fetch achievements:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 13D. UGC: PUBLISH (OR UPDATE) A LEVEL ---
// Publishes a new level, or - if "id" names a level this caller already owns - overwrites it in
// place. "data" is an opaque JSON blob; the platform never looks inside it.
communityGamesRoute.post("/:id/levels", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const title = typeof body.title === "string" ? body.title.trim() : "";
	if (title.length === 0 || title.length > MAX_LEVEL_TITLE_LENGTH) {
		return c.json({ success: false, code: "INVALID_LEVEL_TITLE" }, 400);
	}

	if (body.data === undefined) {
		return c.json({ success: false, code: "MISSING_DATA" }, 400);
	}

	const serialized = JSON.stringify(body.data);
	if (serialized.length > MAX_LEVEL_JSON_LENGTH) {
		return c.json({ success: false, code: "LEVEL_TOO_LARGE" }, 413);
	}

	const existingId = typeof body.id === "string" && body.id ? body.id : null;

	try {
		const [game] = await database
			.select({ id: communityGame.id })
			.from(communityGame)
			.where(eq(communityGame.id, gameId))
			.limit(1);

		if (!game) return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);

		if (existingId) {
			const [existing] = await database
				.select({ userId: communityGameLevels.userId })
				.from(communityGameLevels)
				.where(and(eq(communityGameLevels.id, existingId), eq(communityGameLevels.gameId, gameId)))
				.limit(1);

			if (!existing) return c.json({ success: false, code: "LEVEL_NOT_FOUND" }, 404);
			if (existing.userId !== user.id) {
				return c.json({ success: false, code: "FORBIDDEN" }, 403);
			}

			const now = new Date();
			await database
				.update(communityGameLevels)
				.set({ title, data: body.data, updatedAt: now })
				.where(eq(communityGameLevels.id, existingId));

			return c.json({
				success: true,
				code: "SUCCESS",
				level: { id: existingId, title, updatedAt: now },
				rateLimit
			});
		}

		const [{ count }] = await database
			.select({ count: sql<number>`count(*)::int` })
			.from(communityGameLevels)
			.where(and(eq(communityGameLevels.gameId, gameId), eq(communityGameLevels.userId, user.id)));

		if (count >= MAX_LEVELS_PER_USER_PER_GAME) {
			return c.json({ success: false, code: "TOO_MANY_LEVELS" }, 400);
		}

		const [level] = await database
			.insert(communityGameLevels)
			.values({ gameId, userId: user.id, title, data: body.data })
			.returning();

		return c.json({
			success: true,
			code: "SUCCESS",
			level: {
				id: level.id,
				title: level.title,
				createdAt: level.createdAt,
				updatedAt: level.updatedAt
			},
			rateLimit
		});
	} catch (error) {
		console.error("Failed to publish level:", error);
		return c.json({ success: false, code: "PUBLISH_FAILED" }, 500);
	}
});

// --- 13E. UGC: LIST PUBLISHED LEVELS ---
communityGamesRoute.get("/:id/levels", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	const mine = c.req.query("mine") === "true";

	const limitRaw = Number(c.req.query("limit"));
	const limit = Number.isInteger(limitRaw)
		? Math.min(Math.max(limitRaw, 1), LEVELS_PAGE_SIZE_MAX)
		: LEVELS_PAGE_SIZE_DEFAULT;

	const offsetRaw = Number(c.req.query("offset"));
	const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

	try {
		const conditions = mine
			? and(eq(communityGameLevels.gameId, gameId), eq(communityGameLevels.userId, user.id))
			: eq(communityGameLevels.gameId, gameId);

		// Fetch one extra row to know whether there's another page, without a separate count query.
		const rows = await database
			.select({
				id: communityGameLevels.id,
				title: communityGameLevels.title,
				creator: users.username,
				creatorDisplayName: users.displayName,
				createdAt: communityGameLevels.createdAt,
				updatedAt: communityGameLevels.updatedAt
			})
			.from(communityGameLevels)
			.innerJoin(users, eq(communityGameLevels.userId, users.userId))
			.where(conditions)
			.orderBy(desc(communityGameLevels.createdAt))
			.limit(limit + 1)
			.offset(offset);

		const hasMore = rows.length > limit;

		return c.json({
			success: true,
			code: "SUCCESS",
			levels: rows.slice(0, limit),
			hasMore,
			rateLimit
		});
	} catch (error) {
		console.error("Failed to list levels:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 13F. UGC: GET ONE LEVEL (including its data) ---
communityGamesRoute.get("/:id/levels/:levelId", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	const levelId = c.req.param("levelId");

	try {
		const [level] = await database
			.select({
				id: communityGameLevels.id,
				title: communityGameLevels.title,
				data: communityGameLevels.data,
				creator: users.username,
				creatorDisplayName: users.displayName,
				createdAt: communityGameLevels.createdAt,
				updatedAt: communityGameLevels.updatedAt
			})
			.from(communityGameLevels)
			.innerJoin(users, eq(communityGameLevels.userId, users.userId))
			.where(and(eq(communityGameLevels.id, levelId), eq(communityGameLevels.gameId, gameId)))
			.limit(1);

		if (!level) return c.json({ success: false, code: "LEVEL_NOT_FOUND" }, 404);

		return c.json({ success: true, code: "SUCCESS", level, rateLimit });
	} catch (error) {
		console.error("Failed to fetch level:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 13G. UGC: DELETE A LEVEL (author, or the game's creator/mods) ---
communityGamesRoute.delete("/:id/levels/:levelId", requireAuth, sdkActionLimiter, async (c) => {
	const user = c.get("user");
	if (await checkIfBanned(user.id, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const gameId = c.req.param("id");
	const rateLimit = sdkActionLimiter.getStatus(sdkRateLimitKey(c, gameId));
	const levelId = c.req.param("levelId");

	try {
		const [level] = await database
			.select({ userId: communityGameLevels.userId })
			.from(communityGameLevels)
			.where(and(eq(communityGameLevels.id, levelId), eq(communityGameLevels.gameId, gameId)))
			.limit(1);

		if (!level) return c.json({ success: false, code: "LEVEL_NOT_FOUND" }, 404);

		if (level.userId !== user.id && !(await canManageGame(gameId, user.id))) {
			return c.json({ success: false, code: "FORBIDDEN" }, 403);
		}

		await database.delete(communityGameLevels).where(eq(communityGameLevels.id, levelId));

		return c.json({ success: true, code: "SUCCESS", id: levelId, rateLimit });
	} catch (error) {
		console.error("Failed to delete level:", error);
		return c.json({ success: false, code: "DELETE_FAILED" }, 500);
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
		// A player can now have one highscore row PER CATEGORY, so this is a list, not a single row.
		const highscores = await database
			.select({
				userId: communityGameHighscores.userId,
				category: communityGameHighscores.category,
				score: communityGameHighscores.score,
				flagged: communityGameHighscores.flagged,
				flagReason: communityGameHighscores.flagReason,
				updatedAt: communityGameHighscores.updatedAt
			})
			.from(communityGameHighscores)
			.where(eq(communityGameHighscores.gameId, gameId));

		// Scoped to the default slot only - the moderation panel is a single-value viewer, same as
		// before named save slots existed. A game's other slots aren't exposed here.
		const saves = await database
			.select({
				userId: communityGameSaves.userId,
				data: communityGameSaves.data,
				updatedAt: communityGameSaves.updatedAt
			})
			.from(communityGameSaves)
			.where(
				and(eq(communityGameSaves.gameId, gameId), eq(communityGameSaves.slot, DEFAULT_SAVE_SLOT))
			);

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

		const highscoresByUser = new Map<string, typeof highscores>();
		for (const h of highscores) {
			const list = highscoresByUser.get(h.userId) ?? [];
			list.push(h);
			highscoresByUser.set(h.userId, list);
		}
		const saveMap = new Map(saves.map((s) => [s.userId, s]));

		const players = playerUsers.map((p) => {
			const userHighscores = highscoresByUser.get(p.userId) ?? [];
			const defaultEntry = userHighscores.find((h) => h.category === DEFAULT_LEADERBOARD_CATEGORY);

			return {
				...p,
				// One entry per leaderboard category this player has a score in.
				highscores: userHighscores,
				// Backward-compatible single-value fields, mirroring the "default" category only.
				highscore: defaultEntry?.score ?? null,
				highscoreFlagged: defaultEntry?.flagged ?? false,
				highscoreFlagReason: defaultEntry?.flagReason ?? null,
				highscoreUpdatedAt: defaultEntry?.updatedAt ?? null,
				save: saveMap.get(p.userId)?.data ?? null,
				saveUpdatedAt: saveMap.get(p.userId)?.updatedAt ?? null
			};
		});

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
		// Scoped to the default slot only - see the matching note on GET /manage/players.
		const [previous] = await database
			.select({ data: communityGameSaves.data })
			.from(communityGameSaves)
			.where(
				and(
					eq(communityGameSaves.gameId, gameId),
					eq(communityGameSaves.userId, targetUserId),
					eq(communityGameSaves.slot, DEFAULT_SAVE_SLOT)
				)
			)
			.limit(1);

		const now = new Date();
		await database
			.insert(communityGameSaves)
			.values({
				gameId,
				userId: targetUserId,
				slot: DEFAULT_SAVE_SLOT,
				data: body.data,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: [communityGameSaves.gameId, communityGameSaves.userId, communityGameSaves.slot],
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
		// Scoped to the default slot only - see the matching note on GET /manage/players.
		const [previous] = await database
			.select({ data: communityGameSaves.data })
			.from(communityGameSaves)
			.where(
				and(
					eq(communityGameSaves.gameId, gameId),
					eq(communityGameSaves.userId, targetUserId),
					eq(communityGameSaves.slot, DEFAULT_SAVE_SLOT)
				)
			)
			.limit(1);

		await database
			.delete(communityGameSaves)
			.where(
				and(
					eq(communityGameSaves.gameId, gameId),
					eq(communityGameSaves.userId, targetUserId),
					eq(communityGameSaves.slot, DEFAULT_SAVE_SLOT)
				)
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

	const category = sanitizeCategory(body.category ?? c.req.query("category"));
	if (category === null) {
		return c.json({ success: false, code: "INVALID_CATEGORY" }, 400);
	}

	try {
		const [previous] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId),
					eq(communityGameHighscores.category, category)
				)
			)
			.limit(1);

		const now = new Date();
		await database
			.insert(communityGameHighscores)
			.values({
				gameId,
				userId: targetUserId,
				category,
				score,
				flagged: false,
				flagReason: null,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: [
					communityGameHighscores.gameId,
					communityGameHighscores.userId,
					communityGameHighscores.category
				],
				// A manual edit by a creator/mod is itself a form of approval - clear any anomaly flag.
				set: { score, flagged: false, flagReason: null, updatedAt: now }
			});

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "edit_highscore",
			details: { category, previousScore: previous?.score ?? null, newScore: score }
		});

		return c.json({ success: true, code: "SUCCESS", category, score });
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

	const category = sanitizeCategory(c.req.query("category"));
	if (category === null) {
		return c.json({ success: false, code: "INVALID_CATEGORY" }, 400);
	}

	try {
		const [updated] = await database
			.update(communityGameHighscores)
			.set({ flagged: false, flagReason: null })
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId),
					eq(communityGameHighscores.category, category)
				)
			)
			.returning({ score: communityGameHighscores.score });

		if (!updated) return c.json({ success: false, code: "NOT_FOUND" }, 404);

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "approve_highscore",
			details: { category, approvedScore: updated.score }
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

	const category = sanitizeCategory(c.req.query("category"));
	if (category === null) {
		return c.json({ success: false, code: "INVALID_CATEGORY" }, 400);
	}

	try {
		const [previous] = await database
			.select({ score: communityGameHighscores.score })
			.from(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId),
					eq(communityGameHighscores.category, category)
				)
			)
			.limit(1);

		await database
			.delete(communityGameHighscores)
			.where(
				and(
					eq(communityGameHighscores.gameId, gameId),
					eq(communityGameHighscores.userId, targetUserId),
					eq(communityGameHighscores.category, category)
				)
			);

		await logGameAudit({
			gameId,
			creatorId: user.id,
			targetUserId,
			action: "delete_highscore",
			details: { category, deletedScore: previous?.score ?? null }
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

	// Anti-sandbox-bypass: frame-ancestors (below) only stops a THIRD-PARTY site from framing this
	// file - it does nothing to stop someone just sending the raw URL to a victim and having their
	// browser navigate to it directly as a normal top-level page. Opened that way, none of the
	// player page's <iframe sandbox="..."> restrictions apply (no opaque origin, popups/top-nav
	// unrestricted, full permissions), so an attacker-uploaded game would run with full browser
	// capabilities under a trusted davidnet.net subdomain - ideal for phishing. The Sec-Fetch-Dest
	// request header (sent by all modern browsers, not spoofable by a page's own JS) says whether
	// THIS request is for a nested browsing context ("iframe") or something else ("document" for a
	// direct/typed navigation, "empty" for a fetch, etc.) - only documents loaded as an iframe may
	// proceed. Fails open when the header is absent (very old browsers / non-browser clients) since
	// that's a compatibility gap, not the phishing-via-real-browser threat this defends against.
	const secFetchDest = c.req.header("Sec-Fetch-Dest");
	if (filePath.endsWith(".html") && secFetchDest && secFetchDest !== "iframe") {
		return c.json(
			{ error: "This file can only be loaded inside the Davidnet game player." },
			403
		);
	}

	// Moderation takedowns must actually take the game down - the metadata endpoints (GET /:id,
	// GET /feed) already hide moderated games, but this file route served the raw content
	// regardless, so a removed game's iframe/src URL kept working for anyone who had it.
	const [game] = await database
		.select({ isModerated: communityGame.isModerated })
		.from(communityGame)
		.where(eq(communityGame.id, id));
	if (!game || game.isModerated) return c.json({ error: "File not found" }, 404);

	const s3Key = `${id}/${filePath}`;

	try {
		const s3Object = await getFromBucket("communitygames", s3Key);
		if (!s3Object.Body) return c.json({ error: "File not found" }, 404);

		// Games can now be updated in place (PUT /:id/upload), so these files are no longer
		// immutable - an ETag + short max-age lets the browser cheaply revalidate (304) instead of
		// blindly trusting a stale cached copy for a full day after an update.
		const etag = s3Object.ETag;
		if (etag && c.req.header("If-None-Match") === etag) {
			// Discard the unread body, otherwise its socket stays checked out of the S3 pool and
			// repeated revalidations eventually exhaust it, stalling every S3 read.
			(s3Object.Body as { destroy?: () => void }).destroy?.();
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
				"connect-src 'self'; " +
				// Without this, frame-src also falls back to the permissive default-src above, so
				// uploaded game code could embed third-party iframes (ad/tracker overlays,
				// clickjacking, phishing). No legitimate HTML5 game needs to nest an iframe.
				"frame-src 'none'; " +
				// Only our own player page may frame this file, and only with the sandbox attribute
				// IT controls (no allow-same-origin). Without this, any external site could frame the
				// file directly with its own (unrestricted) sandbox attribute and recover the real
				// davidnet-backend.davidnet.net origin for the uploaded game's JS, defeating the
				// sandboxing entirely and exposing session cookies.
				"frame-ancestors https://davidnet.net https://*.davidnet.net;"
		);

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "File not found" }, 404);
	}
});
