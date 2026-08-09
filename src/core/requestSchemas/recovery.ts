import { type } from "arktype";

export const sendRecoveryEmailSchema = type({
	email: "string"
});

export const resetPasswordSchema = type({
	token: "string",
	newPassword: "string"
});
