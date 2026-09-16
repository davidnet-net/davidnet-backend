import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

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
			// Auto-clear expired ban in the background
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

	// Check if user is banned before allowing upload action
	if (await checkIfBanned(userId, c)) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const body = await c.req.parseBody();

	const title = body["title"];
	const file = body["video"];

	// Title validation
	if (typeof title !== "string" || title.trim().length === 0) {
		return c.json({ success: false, code: "MISSING_TITLE" }, 400);
	}

	const trimmedTitle = title.trim();
	if (trimmedTitle.length > 100) {
		return c.json({ success: false, code: "TITLE_TOO_LONG" }, 400);
	}

	// File validation
	if (!file || !(file instanceof File)) {
		return c.json({ success: false, code: "MISSING_VIDEO_FILE" }, 400);
	}

	const allowedTypes = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"];
	if (!allowedTypes.includes(file.type)) {
		return c.json({ success: false, code: "INVALID_FILE_TYPE" }, 400);
	}

	// 100MB File Size Limit
	const MAX_FILE_SIZE = 35 * 1024 * 1024;
	if (file.size > MAX_FILE_SIZE) {
		return c.json({ success: false, code: "FILE_TOO_LARGE" }, 400);
	}

	const fileExt =
		file.type.split("/")[1] === "quicktime" ? "mov" : file.type.split("/")[1] || "mp4";
	const shortId = crypto.randomUUID();
	const fileName = `${shortId}.${fileExt}`;
	const buffer = Buffer.from(await file.arrayBuffer());

	try {
		// Upload to S3 bucket named "shorts"
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
				videoLength: 0,
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

// --- 2. GET SHORTS FEED ---
shortsRoute.get("/", collectAuth, async (c) => {
	// If a logged-in user is making requests, check if they are banned
	const user = c.get("user");
	if (user && (await checkIfBanned(user.id, c))) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const limitQuery = c.req.query("limit");
	const offsetQuery = c.req.query("offset");

	let limit = 15;
	let offset = 0;

	if (limitQuery) {
		const parsedLimit = parseInt(limitQuery, 10);
		if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 50) {
			limit = parsedLimit;
		}
	}

	if (offsetQuery) {
		const parsedOffset = parseInt(offsetQuery, 10);
		if (!isNaN(parsedOffset) && parsedOffset > 0) {
			offset = parsedOffset;
		}
	}

	try {
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
				createdAt: shorts.createdAt
			})
			.from(shorts)
			.innerJoin(users, eq(shorts.userId, users.userId))
			.where(eq(shorts.isModerated, false))
			.orderBy(desc(shorts.createdAt))
			.limit(limit)
			.offset(offset);

		return c.json({
			success: true,
			code: "SUCCESS",
			shorts: result
		});
	} catch (error) {
		console.error("Failed to fetch shorts feed:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 3. GET SINGLE SHORT ---
shortsRoute.get("/:id", collectAuth, async (c) => {
	const user = c.get("user");
	if (user && (await checkIfBanned(user.id, c))) {
		return c.json({ success: false, code: "BANNED" }, 403);
	}

	const id = c.req.param("id");

	try {
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
				createdAt: shorts.createdAt
			})
			.from(shorts)
			.innerJoin(users, eq(shorts.userId, users.userId))
			.where(and(eq(shorts.id, id), eq(shorts.isModerated, false)))
			.limit(1);

		const targetShort = result[0];

		if (!targetShort) {
			return c.json({ success: false, code: "SHORT_NOT_FOUND" }, 404);
		}

		return c.json({
			success: true,
			code: "SUCCESS",
			short: targetShort
		});
	} catch (error) {
		console.error("Failed to fetch short:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 4. VIDEO RETRIEVAL / STREAMING ---
shortsRoute.get("/video/:filename", async (c) => {
	const filename = c.req.param("filename");
	if (!filename) {
		return c.json({ error: "Missing filename" }, 400);
	}

	try {
		const s3Object = await getFromBucket("shorts", filename);

		if (!s3Object.Body) {
			return c.json({ error: "Video not found" }, 404);
		}

		c.header("Content-Type", s3Object.ContentType || "video/mp4");
		c.header("Cache-Control", "public, max-age=86400, must-revalidate");

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "Video not found" }, 404);
	}
});

// --- 5. MODERATE / UNMODERATE SHORT (Moderator Action) ---
shortsRoute.patch("/:id/moderate", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const shortId = c.req.param("id");
	let body;

	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const { isModerated } = body;

	if (typeof isModerated !== "boolean") {
		return c.json({ success: false, code: "INVALID_IS_MODERATED_VALUE" }, 400);
	}

	try {
		const [updatedShort] = await database
			.update(shorts)
			.set({
				isModerated,
				updatedAt: new Date()
			})
			.where(eq(shorts.id, shortId))
			.returning();

		if (!updatedShort) {
			return c.json({ success: false, code: "SHORT_NOT_FOUND" }, 404);
		}

		return c.json({
			success: true,
			code: isModerated ? "SHORT_MODERATED" : "SHORT_UNMODERATED",
			short: updatedShort
		});
	} catch (error) {
		console.error("Failed to moderate short:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});
