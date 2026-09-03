import { type } from "arktype";

export const createQuizSchema = type({
	name: "string"
});

export const updateQuizSchema = type({
	"name?": "string"
});

export const addCollaboratorSchema = type({
	userId: "string"
});
