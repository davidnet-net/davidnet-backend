import { type } from "arktype";

export const uploadVideoSchema = type({
	title: "string",
	video: "File | Blob"
});

export const getFeedSchema = type({
	"limit?": "string",
	"cursor?": "string"
});
