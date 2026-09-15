import { type } from "arktype";

export const createReportSchema = type({
	reportType: "'profile' | 'short'",
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
	bannedUntil: "string | null"
});

export const createViolationSchema = type({
	userId: "string",
	reportedType: "'profile' | 'short'",
	reportedId: "string",
	reason: "string",
	"moderatorReason?": "string"
});
