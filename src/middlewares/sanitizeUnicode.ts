import { createMiddleware } from "hono/factory";

// Max length safety limit to prevent resource exhaustion attacks via huge repeated characters
const MAX_STRING_LENGTH = 10000;

export function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") {
		// Truncate excessively long strings
		const truncated = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;

		return (
			truncated
				.normalize("NFC")
				// Strips diacritics / combining marks
				.replace(/\p{M}/gu, "")
				// Strips invisible zero-width characters, direction overrides, and invisible separators
				.replace(/[\u200B-\u200D\u202E\uFEFF\u200E\u200F\u2060-\u206F]/g, "")
				// Strips ASCII control characters (except standard newlines and tabs)
				.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
		);
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item));
	}

	if (value !== null && typeof value === "object") {
		// Ensure we don't sanitize File objects in multipart forms
		if (value instanceof File) return value;

		return Object.fromEntries(
			Object.entries(value).map(([key, val]) => [
				// Clean keys safely without stripping essential key characters
				String(sanitizeValue(key)),
				sanitizeValue(val)
			])
		);
	}

	return value;
}

export const sanitizeUnicode = createMiddleware(async (c, next) => {
	const contentType = c.req.header("content-type") || "";

	if (contentType.includes("application/json")) {
		try {
			const rawBody = await c.req.json();
			const cleanedBody = sanitizeValue(rawBody);
			// Re-assign the parsed JSON body safely
			c.req.json = async <T = any>(): Promise<T> => cleanedBody as T;
		} catch {
			// Let invalid JSON fall through to be caught by Hono's standard JSON parser/error handler
		}
	} else if (
		contentType.includes("application/x-www-form-urlencoded") ||
		contentType.includes("multipart/form-data")
	) {
		try {
			const rawBody = await c.req.parseBody();
			const cleanedBody = sanitizeValue(rawBody) as Record<string, string | File>;
			c.req.parseBody = async () => cleanedBody;
		} catch {
			// Pass through parsing failures
		}
	}

	await next();
});
