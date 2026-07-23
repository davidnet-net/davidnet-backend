import { type } from "arktype";

export const changePasswordSchema = type({
	oldPassword: "string",
	newPassword: "string"
});

export const logoutSessionSchema = type({
	jwtID: "string"
});
