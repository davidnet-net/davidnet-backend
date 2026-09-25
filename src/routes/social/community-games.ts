import { eq, and, desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import AdmZip from "adm-zip";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { database } from "../../core/database/client";
import {
	accountModerationStatus,
	internalAccess,
	communityGame,
	communityGameLikes,
	users
} from "../../core/database/schema/schema";
import { type Env, requireAuth } from "../../middlewares/requireAuth";
import { collectAuth } from "../../middlewares/collectAuth";
import { uploadToBucket, getFromBucket } from "../../core/shared/s3";

export const communityGamesRoute = new Hono<Env>();

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
				isModerated: false
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

			const fileData = entry.getData();
			const s3Key = `${gameId}/${filePath}`;

			let contentType = "application/octet-stream";
			if (filePath.endsWith(".html")) contentType = "text/html";
			else if (filePath.endsWith(".css")) contentType = "text/css";
			else if (filePath.endsWith(".js")) contentType = "application/javascript";
			else if (filePath.endsWith(".png")) contentType = "image/png";
			else if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) contentType = "image/jpeg";
			else if (filePath.endsWith(".mp3")) contentType = "audio/mpeg";
			else if (filePath.endsWith(".wav")) contentType = "audio/wav";
			else if (filePath.endsWith(".svg")) contentType = "image/svg+xml";

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
communityGamesRoute.get("/feed", collectAuth, async (c) => {
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

// --- 3. LIKE / UNLIKE COMMUNITY GAME ---
communityGamesRoute.post("/:id/like", collectAuth, async (c) => {
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
communityGamesRoute.get("/:id", collectAuth, async (c) => {
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
		const s3 = new S3Client({
			region: process.env.AWS_REGION || "us-east-1",
			credentials: {
				accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
				secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ""
			},
			...(process.env.AWS_ENDPOINT
				? { endpoint: process.env.AWS_ENDPOINT, forcePathStyle: true }
				: {})
		});

		const command = new ListObjectsV2Command({
			Bucket: process.env.S3_BUCKET_COMMUNITYGAMES || "communitygames",
			Prefix: `${gameId}/`
		});

		const response = await s3.send(command);
		const files = (response.Contents || [])
			.map((item) => {
				const key = item.Key || "";
				return key.replace(`${gameId}/`, "");
			})
			.filter(Boolean);

		return c.json({ success: true, files });
	} catch (error) {
		console.error("Failed to list game files:", error);
		return c.json({ success: false, code: "LIST_FILES_FAILED" }, 500);
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

		// Expliciete CSP headers voor iframe game isolatie om CSP fouten en Cloudflare spam te voorkomen
		c.header(
			"Content-Security-Policy",
			"default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; media-src * data: blob:; font-src * data:; style-src 'self' 'unsafe-inline';"
		);

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "File not found" }, 404);
	}
});
