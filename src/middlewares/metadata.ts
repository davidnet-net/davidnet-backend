import { createMiddleware } from "hono/factory";
export type Env = {
	Variables: {
		metadata: {
			ip: string;
			countryCode: string;
			userAgent: string;
		};
	};
};

export const createMetadata = createMiddleware<Env>(async (c, next) => {
	const cfIp = c.req.header("cf-connecting-ip");
	const cfCountry = c.req.header("cf-ipcountry");
	const forwardedFor = c.req.header("x-forwarded-for");
	const userAgent = c.req.header("user-agent");
	let clientIp = cfIp;
	if (!clientIp && forwardedFor) {
		clientIp = forwardedFor.split(",")[0].trim();
	}

	// Final fallback if neither header is present
	if (!clientIp) {
		console.warn("[metadata]: NO IP ADDRESS DETECTED");
	}
	clientIp = clientIp || "Unknown IP";

	c.set("metadata", {
		ip: clientIp,
		countryCode: cfCountry || "??",
		userAgent: userAgent || "Unknown"
	});

	await next();
});
