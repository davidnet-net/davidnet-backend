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

export const onboardingPrivacySchema = type({
	"languageVisibility?": visibilityType,
	"timezoneVisibility?": visibilityType,
	"locationVisibility?": visibilityType,
	"emailVisibility?": visibilityType
});
