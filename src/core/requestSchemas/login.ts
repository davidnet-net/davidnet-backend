import { type } from "arktype";

export const loginSchema = type({
	identifier: "string", // Could be username or email
	password: "string"
});

export const verify2faSchema = type({
	mfaToken: "string",
	code: "string"
});

export const verifyRecoveryCodeSchema = type({
	mfaToken: "string",
	code: "string"
});
