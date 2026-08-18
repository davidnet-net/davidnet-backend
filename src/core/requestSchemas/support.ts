import { type } from "arktype";

export const feedbackSchema = type({
	message: "string",
	appState: "unknown",
	DDS_INFO: "unknown",
	safeIdentity: "unknown",
	referrer: "string",
	authState: "unknown",
	timestamp: "string",
	URL: "string",
	userAgent: "string",
	viewport: {
		width: "number",
		height: "number",
		pixelRatio: "number"
	}
});
