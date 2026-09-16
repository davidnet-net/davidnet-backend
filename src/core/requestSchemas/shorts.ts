import { type } from "arktype";

export const uploadVideoSchema = type({
	title: "string",
	video: "File | Blob"
});

export const getFeedSchema = type({
	"limit?": "number",
	"seenIds?": "string[]"
});

export const watchMetricSchema = type({
	watchDuration: "number"
});

export const likeMetricSchema = type({
	liked: "boolean"
});
