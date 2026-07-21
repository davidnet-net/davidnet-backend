import { type } from "arktype";

export const loginSchema = type({
	identifier: "string", // Could be username or email
	password: "string"
});
