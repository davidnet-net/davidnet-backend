import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { shorts, users } from "../../core/database/schema/schema";
import { requireAuth, type Env } from "../../middlewares/requireAuth";
import { collectAuth } from "../../middlewares/collectAuth";
import { uploadToBucket, getFromBucket } from "../../core/shared/s3";

export const shortsRoute = new Hono<Env>();

// --- 1. UPLOAD SHORT ---
shortsRoute.post("/", requireAuth, async (c) => {
	const userId = c.get("user").id;
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
	const MAX_FILE_SIZE = 100 * 1024 * 1024;
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

		const videoUrl = `https://davidnet-backend.davidnet.net/auth/shorts/video/${fileName}`;

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
				videoLength: 0
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
	const limitQuery = c.req.query("limit");
	let limit = 10;

	if (limitQuery) {
		const parsedLimit = parseInt(limitQuery, 10);
		if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 50) {
			limit = parsedLimit;
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
			.orderBy(desc(shorts.createdAt))
			.limit(limit);

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
			.where(eq(shorts.id, id))
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
