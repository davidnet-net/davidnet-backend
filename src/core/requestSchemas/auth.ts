import { type } from "arktype";

export const signupSchema = type({
	email: "string.email",
	username: /^[a-zA-Z0-9_-]+$/,
	password: "string>8"
});
