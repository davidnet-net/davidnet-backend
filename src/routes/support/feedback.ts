import { type } from "arktype";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Env, requireAuth } from "../../middlewares/requireAuth";
import { createRateLimiter } from "../../middlewares/rateLimiter";
import { feedbackSchema } from "../../core/requestSchemas/support";
import { database } from "../../core/database/client";
import { feedbackTable } from "../../core/database/schema/support";
import { internalAccess, users } from "../../core/database/schema/schema";
import { getFromBucket, uploadToBucket } from "../../core/shared/s3";

export const feedback = new Hono<Env>();

// Max rows returned per request - this is an internal review list, not a paginated feed, so a
// generous flat cap (matching the style of the other /support/moderation/*/all endpoints) is
// enough to keep the response bounded as submissions accumulate over time.
const MAX_FEEDBACK_LIST_SIZE = 300;

// --- ATTACHMENTS (screenshots/recordings submitted alongside feedback) ---
const MAX_ATTACHMENTS_TOTAL_BYTES = 50 * 1024 * 1024; // 50MB combined, across all attached files
const MAX_ATTACHMENT_COUNT = 10;
const ALLOWED_ATTACHMENT_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"video/mp4",
	"video/webm",
	"video/quicktime"
];

interface FeedbackAttachment {
	key: string;
	filename: string;
	contentType: string;
	size: number;
}

// Strips directory separators and leading dots from a client-supplied filename before it's used
// in an S3 key, so a crafted name (e.g. "../../other-group/x") can't escape the attachment's own
// key prefix - same spirit as the path-traversal guard added for community game zip entries.
function sanitizeAttachmentFilename(filename: string): string {
	const base = filename.replace(/^.*[/\\]/, "").replace(/^\.+/, "");
	return base.length > 0 ? base : "file";
}

// --- HELPER: CHECK MODERATOR/SUPPORT PERMISSIONS (same bar as support/moderation.ts) ---
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

feedback.post("/", createRateLimiter(10, 15 * 60 * 1000), requireAuth, async (c) => {
	const userID = c.get("user").id;

	// multipart/form-data now (not plain JSON) so screenshots/recordings can ride along with the
	// report - the arktype-validated payload travels as a single JSON-encoded text field.
	const body = await c.req.parseBody({ all: true });
	const rawPayload = body["payload"];

	if (typeof rawPayload !== "string") {
		return c.json({ success: false, code: "MISSING_PAYLOAD" }, 400);
	}

	let parsedPayload: unknown;
	try {
		parsedPayload = JSON.parse(rawPayload);
	} catch {
		return c.json({ success: false, code: "INVALID_PAYLOAD_JSON" }, 400);
	}

	const result = feedbackSchema(parsedPayload);
	if (result instanceof type.errors) {
		return c.json({ success: false, code: "INVALID_REQUEST_BODY", errors: result.summary }, 400);
	}

	const rawAttachments = body["attachments"];
	const attachmentFiles = (Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments]).filter(
		(f): f is File => f instanceof File
	);

	if (attachmentFiles.length > MAX_ATTACHMENT_COUNT) {
		return c.json({ success: false, code: "TOO_MANY_ATTACHMENTS" }, 400);
	}

	let totalAttachmentBytes = 0;
	for (const file of attachmentFiles) {
		if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
			return c.json({ success: false, code: "INVALID_ATTACHMENT_TYPE" }, 400);
		}

		totalAttachmentBytes += file.size;
		if (totalAttachmentBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
			return c.json({ success: false, code: "ATTACHMENTS_TOO_LARGE" }, 400);
		}
	}

	try {
		// Keyed by a throwaway id rather than the (not-yet-known) feedback row id - purely a
		// namespace to keep one submission's files together in the bucket.
		const attachmentGroupId = crypto.randomUUID();
		const attachments: FeedbackAttachment[] = [];

		for (const [index, file] of attachmentFiles.entries()) {
			const key = `${attachmentGroupId}/${index}-${sanitizeAttachmentFilename(file.name)}`;
			const fileBuffer = Buffer.from(await file.arrayBuffer());
			await uploadToBucket("feedback", key, fileBuffer, file.type);
			attachments.push({ key, filename: file.name, contentType: file.type, size: file.size });
		}

		await database.insert(feedbackTable).values({
			userId: userID,
			data: { ...result, attachments }
		});

		return c.json({
			success: true,
			code: "FEEDBACK_SUBMITTED"
		});
	} catch (error) {
		console.error("Failed to submit feedback:", error);
		return c.json({ success: false, code: "SUBMIT_FAILED" }, 500);
	}
});

// --- GET ALL SUBMITTED FEEDBACK (support staff only) ---
feedback.get("/all", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	try {
		// feedbackId is a uuidv7 (time-ordered), so sorting by it is equivalent to sorting by
		// insertion time without needing a dedicated created_at column.
		const allFeedback = await database
			.select({
				feedbackId: feedbackTable.feedbackId,
				userId: feedbackTable.userId,
				data: feedbackTable.data,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl
			})
			.from(feedbackTable)
			.leftJoin(users, eq(feedbackTable.userId, users.userId))
			.orderBy(desc(feedbackTable.feedbackId))
			.limit(MAX_FEEDBACK_LIST_SIZE);

		return c.json({
			success: true,
			code: "SUCCESS",
			feedback: allFeedback
		});
	} catch (error) {
		console.error("Failed to fetch feedback:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- GET A FEEDBACK ATTACHMENT (support staff only - these are private user uploads) ---
feedback.get("/attachment/*", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const url = new URL(c.req.url);
	const rawKey = url.pathname.split("/attachment/")[1];
	if (!rawKey) return c.json({ success: false, code: "MISSING_KEY" }, 400);

	// url.pathname keeps percent-encoding as-is (e.g. a space in the original filename survives
	// as "%20") - the key was stored in the bucket with the literal, decoded filename, so it has
	// to be decoded back before the lookup or it 404s on any attachment with a space/unicode/etc.
	// in its name.
	const key = decodeURIComponent(rawKey);

	try {
		const object = await getFromBucket("feedback", key);
		if (!object.Body) return c.json({ success: false, code: "FILE_NOT_FOUND" }, 404);

		c.header("Content-Type", object.ContentType || "application/octet-stream");
		c.header("Cache-Control", "private, max-age=60");

		return c.body(object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ success: false, code: "FILE_NOT_FOUND" }, 404);
	}
});
