import { type } from "arktype";

export const uploadGameSchema = type({
	title: "string",
	"description?": "string",
	game: "File | Blob"
});

export const updateGameSchema = type({
	"title?": "string",
	"description?": "string"
});
