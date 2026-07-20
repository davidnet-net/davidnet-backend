import { type } from "arktype";
const visibilityType =
	"'private'|'organizations'|'connections'|'organizations_and_connections'|'public'";

export const signupSchema = type({
	email: "string",
	username: "string",
	password: "string",
	legalAccepted: "boolean"
});

export const changeSignupEmailSchema = type({
	email: "string"
});

export const verifyEmailSchema = type({
	emailVerificationToken: "string"
});

export const initialPreferencesSchema = type({
	theme: "'system' | 'dark' | 'light' | 'contrast'",
	firstDayOfWeek:
		"'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'",
	language: "'en-US' | 'nl'",
	dateFormat: "'YYYY-MM-DD' | 'DD-MM-YYYY' | 'MM-DD-YYYY'",

	timezone: "string"
});
