import { type } from "arktype";

export const uploadVideoSchema = type({
	title: "string",
	video: "File | Blob"
});

export const getFeedSchema = type({
	// Query parameters from the URL are inherently strings before parsing
	"limit?": "string",
	"cursor?": "string"
});
