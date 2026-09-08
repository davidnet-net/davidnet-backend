import { createMiddleware } from "hono/factory";

const MAX_STRING_LENGTH = 10000;

export function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") {
		const truncated = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;

		return (
			truncated
				.normalize("NFC")
				// Behoud alleen West-Europese tekens, cijfers, basistekens ÉN emojis
				// Dit verwijdert automatisch onbekende/exotische schriften (zoals Sinhala, Thais, etc.)
				.replace(/[^\na-zA-Z0-9\u00C0-\u024F _.-–—,!?@#%&*()+'":;\p{Extended_Pictographic}]/gu, "")
				// Strips onzichtbare stuurtekens (behalve de Joiner die emojis soms samenvoegt)
				.replace(/[\u200E\u200F\u202E\uFEFF\u2060-\u206F]/g, "")
				// Strips ASCII control characters (behalve newlines en tabs)
				.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
		);
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item));
	}

	if (value !== null && typeof value === "object") {
		if (value instanceof File) return value;

		return Object.fromEntries(
			Object.entries(value).map(([key, val]) => [String(sanitizeValue(key)), sanitizeValue(val)])
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
			c.req.json = async <T = any>(): Promise<T> => cleanedBody as T;
		} catch {
			// Let invalid JSON fall through
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
