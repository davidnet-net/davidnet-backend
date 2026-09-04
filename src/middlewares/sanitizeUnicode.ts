import { createMiddleware } from "hono/factory";

function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") {
		return value
			.normalize("NFC")
			.replace(/\p{M}/gu, "")
			.replace(/[\u200B-\u200D\u202E\uFEFF]/g, "");
	}
	if (Array.isArray(value)) {
		return value.map(sanitizeValue);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, sanitizeValue(val)]));
	}
	return value;
}

export const sanitizeUnicode = createMiddleware(async (c, next) => {
	const contentType = c.req.header("content-type");

	if (contentType?.includes("application/json")) {
		try {
			const rawBody = await c.req.json();
			const cleanedBody = sanitizeValue(rawBody);

			c.req.json = async <T = any>(): Promise<T> => cleanedBody as T;
		} catch {
			// Allow malformed JSON to pass to default Hono handlers
		}
	}

	await next();
});
