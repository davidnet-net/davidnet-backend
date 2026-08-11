import { type } from "arktype";

export const requestedUserSchema = type({
	requestedUserID: "string"
});

export const connectionIdSchema = type({
	connectionId: "string"
});

export const blockIdSchema = type({
	blockId: "string"
});
