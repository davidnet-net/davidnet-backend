import { type } from "arktype";

export const signupSchema = type({
	email: "string",
	username: "string",
	password: "string",
	legalAccepted: "boolean"
});

export const changeSignupEmailSchema = type({
	email: "string"
});
