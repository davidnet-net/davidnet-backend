import { Hono } from "hono";
import { getFromBucket } from "../core/shared/s3";

// Public, unauthenticated retrieval for quiz question media (images). Deliberately kept
// outside the /workspaces subtree (which requires a Bearer token on every route) since this
// is fetched via plain <img> tags on the presenter display, which cannot send an Authorization
// header. Mirrors the public avatar/banner retrieval pattern in auth/profile.ts.
export const quizMedia = new Hono();

const QUIZ_IMAGES_BUCKET = "quiz-images";

quizMedia.get("/:quizId/:filename", async (c) => {
	const quizId = c.req.param("quizId");
	const filename = c.req.param("filename");
	if (!quizId || !filename) {
		return c.json({ error: "Missing quizId or filename" }, 400);
	}

	try {
		const s3Object = await getFromBucket(QUIZ_IMAGES_BUCKET, `${quizId}/${filename}`);

		if (!s3Object.Body) {
			return c.json({ error: "Image not found" }, 404);
		}

		c.header("Content-Type", s3Object.ContentType || "application/octet-stream");
		c.header("Cache-Control", "public, max-age=86400, must-revalidate");

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "Image not found" }, 404);
	}
});
