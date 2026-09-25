import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getVideoDurationInSeconds } from "get-video-duration";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { database } from "../../core/database/client";
import {
	accountModerationStatus,
	internalAccess,
	shorts,
	users
} from "../../core/database/schema/schema";
import { requireAuth, type Env } from "../../middlewares/requireAuth";
import { collectAuth } from "../../middlewares/collectAuth";
import { uploadToBucket, getFromBucket } from "../../core/shared/s3";

export const shortsRoute = new Hono<Env>();

// --- HELPER: CHECK IF USER IS BANNED ---
async function checkIfBanned(userId: string, c: any) {
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

// --- 1. UPLOAD SHORT ---
shortsRoute.post("/", requireAuth, async (c) => {
	const userId = c.get("user").id;

	if (await checkIfBanned(userId, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const body = await c.req.parseBody();

	const title = body["title"];
	const file = body["video"];

	if (typeof title !== "string" || title.trim().length === 0) {
		return c.json({ success: false, code: "MISSING_TITLE" }, 400);
	}

	const trimmedTitle = title.trim();
	if (trimmedTitle.length > 100) {
		return c.json({ success: false, code: "TITLE_TOO_LONG" }, 400);
	}

	if (!file || !(file instanceof File)) {
		return c.json({ success: false, code: "MISSING_VIDEO_FILE" }, 400);
	}

	const allowedTypes = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"];
	if (!allowedTypes.includes(file.type)) {
		return c.json({ success: false, code: "INVALID_FILE_TYPE" }, 400);
	}

	const MAX_FILE_SIZE = 35 * 1024 * 1024;
	if (file.size > MAX_FILE_SIZE) {
		return c.json({ success: false, code: "FILE_TOO_LARGE" }, 400);
	}

	const fileExt =
		file.type.split("/")[1] === "quicktime" ? "mov" : file.type.split("/")[1] || "mp4";
	const shortId = crypto.randomUUID();
	const fileName = `${shortId}.${fileExt}`;
	const buffer = Buffer.from(await file.arrayBuffer());

	let actualVideoLength = 15; // Safe fallback

	// --- SECURE DURATION EXTRACTION (Temp File Method) ---
	const tempFilePath = path.join(os.tmpdir(), fileName);
	try {
		await fs.writeFile(tempFilePath, buffer);
		const duration = await getVideoDurationInSeconds(tempFilePath);
		actualVideoLength = Math.max(1, Math.round(duration));
	} catch (err) {
		console.warn("Failed to extract video duration, using fallback:", err);
	} finally {
		await fs.unlink(tempFilePath).catch(() => {});
	}

	try {
		await uploadToBucket("shorts", fileName, buffer, file.type);

		const videoUrl = `https://davidnet-backend.davidnet.net/social/shorts/video/${fileName}`;

		const [newShort] = await database
			.insert(shorts)
			.values({
				id: shortId,
				userId: userId,
				title: trimmedTitle,
				videoUrl: videoUrl,
				views: 0,
				likesCount: 0,
				watchDuration: 0,
				videoLength: actualVideoLength,
				isModerated: false
			})
			.returning();

		return c.json({
			success: true,
			code: "SHORT_UPLOADED",
			short: newShort
		});
	} catch (error) {
		console.error("Failed to upload short:", error);
		return c.json({ success: false, code: "UPLOAD_FAILED" }, 500);
	}
});

// --- 2. GET SHORTS FEED (80/20 Algorithmic + Loop Prevention) ---
shortsRoute.post("/feed", collectAuth, async (c) => {
	const user = c.get("user");
	if (user && (await checkIfBanned(user.id, c))) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}

	const limit =
		typeof body.limit === "number" && body.limit > 0 && body.limit <= 50 ? body.limit : 15;
	const seenIds: string[] = Array.isArray(body.seenIds) ? body.seenIds : [];

	const algoLimit = Math.ceil(limit * 0.8);
	const discoveryLimit = limit - algoLimit;

	try {
		// Algorithm Math (Retention + Likes / Time Decay)
		const ageInHours = sql`EXTRACT(EPOCH FROM (NOW() - ${shorts.createdAt})) / 3600`;
		const apv = sql`LEAST(1.0, ${shorts.watchDuration}::float / GREATEST(${shorts.views} * GREATEST(${shorts.videoLength}, 1), 1))`;
		const likeRate = sql`${shorts.likesCount}::float / GREATEST(${shorts.views}, 1)`;
		const algoScore =
			sql<number>`((70.0 * ${apv}) + (30.0 * ${likeRate})) / POWER(${ageInHours} + 1.0, 1.5)`.as(
				"algo_score"
			);

		const algoConditions = [eq(shorts.isModerated, false)];
		const discoveryConditions = [eq(shorts.isModerated, false), sql`${shorts.views} < 50`];

		if (seenIds.length > 0) {
			algoConditions.push(notInArray(shorts.id, seenIds));
			discoveryConditions.push(notInArray(shorts.id, seenIds));
		}

		const algoQuery = database
			.select({
				id: shorts.id,
				title: shorts.title,
				videoUrl: shorts.videoUrl,
				creator: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatarUrl: users.avatarUrl,
				views: shorts.views,
				likesCount: shorts.likesCount,
				watchDuration: shorts.watchDuration,
				videoLength: shorts.videoLength,
				createdAt: shorts.createdAt,
				score: algoScore
			})
			.from(shorts)
			.innerJoin(users, eq(shorts.userId, users.userId))
			.where(and(...algoConditions))
			.orderBy(desc(algoScore))
			.limit(algoLimit);

		const discoveryQuery = database
			.select({
				id: shorts.id,
				title: shorts.title,
				videoUrl: shorts.videoUrl,
				creator: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatarUrl: users.avatarUrl,
				views: shorts.views,
				likesCount: shorts.likesCount,
				watchDuration: shorts.watchDuration,
				videoLength: shorts.videoLength,
				createdAt: shorts.createdAt,
				score: sql<number>`0.0`.as("score")
			})
			.from(shorts)
			.innerJoin(users, eq(shorts.userId, users.userId))
			.where(and(...discoveryConditions))
			.orderBy(desc(shorts.createdAt))
			.limit(discoveryLimit);

		let [algoShorts, discoveryShorts] = await Promise.all([algoQuery, discoveryQuery]);

		let combinedFeed = [];
		let aIndex = 0,
			dIndex = 0;
		while (aIndex < algoShorts.length || dIndex < discoveryShorts.length) {
			for (let i = 0; i < 4 && aIndex < algoShorts.length; i++)
				combinedFeed.push(algoShorts[aIndex++]);
			if (dIndex < discoveryShorts.length) combinedFeed.push(discoveryShorts[dIndex++]);
		}

		let uniqueFeed = Array.from(new Map(combinedFeed.map((item) => [item.id, item])).values());
		let loopRestarted = false;

		// Exhaustion Loop Fallback
		if (uniqueFeed.length < limit && seenIds.length > 0) {
			loopRestarted = true;
			const remainingNeeded = limit - uniqueFeed.length;
			const excludeIds = uniqueFeed.map((v) => v.id);

			const fallbackConditions = [eq(shorts.isModerated, false)];
			if (excludeIds.length > 0) fallbackConditions.push(notInArray(shorts.id, excludeIds));

			const fallbackShorts = await database
				.select({
					id: shorts.id,
					title: shorts.title,
					videoUrl: shorts.videoUrl,
					creator: users.username,
					creatorDisplayName: users.displayName,
					creatorAvatarUrl: users.avatarUrl,
					views: shorts.views,
					likesCount: shorts.likesCount,
					watchDuration: shorts.watchDuration,
					videoLength: shorts.videoLength,
					createdAt: shorts.createdAt,
					score: algoScore
				})
				.from(shorts)
				.innerJoin(users, eq(shorts.userId, users.userId))
				.where(and(...fallbackConditions))
				.orderBy(desc(algoScore))
				.limit(remainingNeeded);

			uniqueFeed = [...uniqueFeed, ...fallbackShorts];
		}

		return c.json({
			success: true,
			code: "SUCCESS",
			shorts: uniqueFeed,
			loopRestarted
		});
	} catch (error) {
		console.error("Failed to fetch shorts feed:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 3. TRACK METRICS: WATCH TIME & VIEWS ---
shortsRoute.post("/:id/watch", async (c) => {
	const shortId = c.req.param("id");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false }, 400);
	}

	const duration = typeof body.watchDuration === "number" ? Math.max(0, body.watchDuration) : 0;

	try {
		await database
			.update(shorts)
			.set({
				views: sql`${shorts.views} + 1`,
				watchDuration: sql`${shorts.watchDuration} + ${duration}`
			})
			.where(eq(shorts.id, shortId));
		return c.json({ success: true });
	} catch (error) {
		return c.json({ success: false }, 500);
	}
});

// --- 4. TRACK METRICS: LIKES ---
shortsRoute.post("/:id/like", collectAuth, async (c) => {
	const shortId = c.req.param("id");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false }, 400);
	}

	const increment = body.liked ? 1 : -1;

	try {
		await database
			.update(shorts)
			.set({ likesCount: sql`GREATEST(${shorts.likesCount} + ${increment}, 0)` })
			.where(eq(shorts.id, shortId));
		return c.json({ success: true });
	} catch (error) {
		return c.json({ success: false }, 500);
	}
});

// --- 5. GET SINGLE SHORT ---
shortsRoute.get("/:id", collectAuth, async (c) => {
	const user = c.get("user");
	if (user && (await checkIfBanned(user.id, c))) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const id = c.req.param("id");
	const modCheck = user ? await isModerator(user.id) : false;

	try {
		const conditions = modCheck
			? eq(shorts.id, id)
			: and(eq(shorts.id, id), eq(shorts.isModerated, false));

		const result = await database
			.select({
				id: shorts.id,
				title: shorts.title,
				videoUrl: shorts.videoUrl,
				creator: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatarUrl: users.avatarUrl,
				views: shorts.views,
				likesCount: shorts.likesCount,
				watchDuration: shorts.watchDuration,
				videoLength: shorts.videoLength,
				isModerated: shorts.isModerated,
				createdAt: shorts.createdAt
			})
			.from(shorts)
			.innerJoin(users, eq(shorts.userId, users.userId))
			.where(conditions)
			.limit(1);

		if (!result[0]) return c.json({ success: false, code: "SHORT_NOT_FOUND" }, 404);

		return c.json({ success: true, code: "SUCCESS", short: result[0] });
	} catch (error) {
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 6. VIDEO RETRIEVAL / STREAMING ---
shortsRoute.get("/video/:filename", async (c) => {
	const filename = c.req.param("filename");
	if (!filename) return c.json({ error: "Missing filename" }, 400);

	try {
		const s3Object = await getFromBucket("shorts", filename);
		if (!s3Object.Body) return c.json({ error: "Video not found" }, 404);

		c.header("Content-Type", s3Object.ContentType || "video/mp4");
		c.header("Cache-Control", "public, max-age=86400, must-revalidate");

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "Video not found" }, 404);
	}
});

// --- 7. MODERATE SHORT ---
shortsRoute.patch("/:id/moderate", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;
	if (!(await isModerator(moderatorId))) return c.json({ success: false, code: "FORBIDDEN" }, 403);

	const shortId = c.req.param("id");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	if (typeof body.isModerated !== "boolean")
		return c.json({ success: false, code: "INVALID" }, 400);

	try {
		const [updatedShort] = await database
			.update(shorts)
			.set({ isModerated: body.isModerated, updatedAt: new Date() })
			.where(eq(shorts.id, shortId))
			.returning();

		if (!updatedShort) return c.json({ success: false, code: "NOT_FOUND" }, 404);

		return c.json({ success: true, short: updatedShort });
	} catch (error) {
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});
