import { type } from "arktype";

export const createReportSchema = type({
	reportType: "'profile' | 'short' | 'game'",
	reportedId: "string",
	reason: "string"
});

export const updateReportStatusSchema = type({
	status: "'pending' | 'resolved' | 'dismissed'"
});

export const getReportsQuerySchema = type({
	"status?": "'pending' | 'resolved' | 'dismissed'",
	"limit?": "string",
	"cursor?": "string"
});

export const banUserSchema = type({
	bannedUntil: "string | null",
	"violationId?": "string",
	"reason?": "string"
});

export const createViolationSchema = type({
	userId: "string",
	reportedType: "'profile' | 'short' | 'game'",
	reportedId: "string",
	reason: "string",
	"moderatorReason?": "string"
});

export const editViolationSchema = type({
	"reason?": "string",
	"moderatorReason?": "string | null"
});

export const moderateShortSchema = type({
	isModerated: "boolean"
});

export const banIpSchema = type({
	"reason?": "string"
});
