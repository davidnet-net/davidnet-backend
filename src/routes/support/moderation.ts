import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type } from "arktype";

import { database } from "../../core/database/client";
import {
	accountModerationStatus,
	internalAccess,
	reports,
	users,
	shorts,
	violations
} from "../../core/database/schema/schema";
import {
	createReportSchema,
	updateReportStatusSchema,
	banUserSchema,
	createViolationSchema
} from "../../core/requestSchemas/moderation";
import { collectAuth } from "../../middlewares/collectAuth";
import { requireAuth, type Env } from "../../middlewares/requireAuth";

export const moderationRoute = new Hono<Env>();

// --- HELPER: CHECK MODERATOR PERMISSIONS ---
async function isModerator(userId: string): Promise<boolean> {
	const [access] = await database
		.select({
			internalAccess: internalAccess.internalAccess,
			supportAccess: internalAccess.supportAccess
		})
		.from(internalAccess)
		.where(eq(internalAccess.userId, userId))
		.limit(1);

	return Boolean(access && access.internalAccess && access.supportAccess);
}

// ============================================================================
// USER ENDPOINTS
// ============================================================================

// --- 1. SUBMIT A REPORT ---
moderationRoute.post("/report", requireAuth, async (c) => {
	const reporterId = c.get("user").id;
	let body;

	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const result = createReportSchema(body);
	if (result instanceof type.errors) {
		return c.json({ success: false, code: "INVALID_REQUEST_BODY", errors: result.summary }, 400);
	}

	const { reportType, reportedId, reason } = result;

	if (reason.trim().length === 0) {
		return c.json({ success: false, code: "MISSING_REASON" }, 400);
	}

	if (reason.length > 2000) {
		return c.json({ success: false, code: "REASON_TOO_LONG" }, 400);
	}

	let actualReportedUserId: string;

	try {
		if (reportType === "short") {
			const [targetShort] = await database
				.select({ userId: shorts.userId })
				.from(shorts)
				.where(eq(shorts.id, reportedId))
				.limit(1);

			if (!targetShort) {
				return c.json({ success: false, code: "SHORT_NOT_FOUND" }, 404);
			}
			actualReportedUserId = targetShort.userId;
		} else if (reportType === "profile") {
			const [targetUser] = await database
				.select({ userId: users.userId })
				.from(users)
				.where(eq(users.userId, reportedId))
				.limit(1);

			if (!targetUser) {
				return c.json({ success: false, code: "USER_NOT_FOUND" }, 404);
			}
			actualReportedUserId = targetUser.userId;
		} else {
			return c.json({ success: false, code: "INVALID_REPORT_TYPE" }, 400);
		}

		const [newReport] = await database
			.insert(reports)
			.values({
				reporterId,
				reportedUserId: actualReportedUserId,
				reportType: reportType as "profile" | "short",
				reportedId,
				reason: reason.trim(),
				status: "pending"
			})
			.returning();

		return c.json(
			{
				success: true,
				code: "REPORT_SUBMITTED",
				report: newReport
			},
			201
		);
	} catch (error) {
		console.error("Failed to submit report:", error);
		return c.json({ success: false, code: "REPORT_SUBMISSION_FAILED" }, 500);
	}
});

// --- 2. GET MY REPORTS LIST ---
moderationRoute.get("/reports/me", requireAuth, async (c) => {
	const reporterId = c.get("user").id;

	try {
		const userReports = await database
			.select({
				id: reports.id,
				reportType: reports.reportType,
				reportedId: reports.reportedId,
				reason: reports.reason,
				status: reports.status,
				createdAt: reports.createdAt,
				updatedAt: reports.updatedAt
			})
			.from(reports)
			.where(eq(reports.reporterId, reporterId))
			.orderBy(desc(reports.createdAt));

		return c.json({
			success: true,
			code: "SUCCESS",
			reports: userReports
		});
	} catch (error) {
		console.error("Failed to fetch user reports:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 3. GET MY VIOLATIONS LIST ---
moderationRoute.get("/violations/me", requireAuth, async (c) => {
	const userId = c.get("user").id;

	try {
		const userViolations = await database
			.select({
				id: violations.id,
				reportedType: violations.reportedType,
				reportedId: violations.reportedId,
				reason: violations.reason,
				moderatorReason: violations.moderatorReason,
				createdAt: violations.createdAt
			})
			.from(violations)
			.where(eq(violations.userId, userId))
			.orderBy(desc(violations.createdAt));

		return c.json({
			success: true,
			code: "SUCCESS",
			violations: userViolations
		});
	} catch (error) {
		console.error("Failed to fetch user violations:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 4. CHECK CURRENT USER BAN STATUS ---
moderationRoute.get("/me/ban-status", collectAuth, async (c) => {
	const user = c.get("user");
	if (!user) {
		return c.json({ success: true, isBanned: false, bannedUntil: null });
	}

	try {
		const [status] = await database
			.select()
			.from(accountModerationStatus)
			.where(eq(accountModerationStatus.userId, user.id))
			.limit(1);

		if (!status || !status.bannedUntil) {
			return c.json({ success: true, isBanned: false, bannedUntil: null });
		}

		const now = new Date();
		const bannedUntilDate = new Date(status.bannedUntil);

		if (bannedUntilDate <= now) {
			await database
				.update(accountModerationStatus)
				.set({ bannedUntil: null, updatedAt: now })
				.where(eq(accountModerationStatus.userId, user.id));

			return c.json({ success: true, isBanned: false, bannedUntil: null });
		}

		return c.json({
			success: true,
			isBanned: true,
			bannedUntil: status.bannedUntil
		});
	} catch (error) {
		console.error("Failed to check ban status:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// ============================================================================
// MODERATOR ENDPOINTS (Requires internalAccess AND supportAccess)
// ============================================================================

// --- 5. GET REPORTS LIST (Moderator Dashboard Queue) ---
moderationRoute.get("/reports", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const statusQuery = c.req.query("status");

	try {
		let query = database
			.select({
				id: reports.id,
				reportType: reports.reportType,
				reportedId: reports.reportedId,
				reason: reports.reason,
				status: reports.status,
				createdAt: reports.createdAt,
				reporterUsername: users.username,
				reporterDisplayName: users.displayName,
				reportedUserId: reports.reportedUserId
			})
			.from(reports)
			.innerJoin(users, eq(reports.reporterId, users.userId))
			.orderBy(desc(reports.createdAt));

		if (statusQuery && ["pending", "resolved", "dismissed"].includes(statusQuery)) {
			query = query.where(
				eq(reports.status, statusQuery as "pending" | "resolved" | "dismissed")
			) as typeof query;
		}

		const reportList = await query;

		return c.json({
			success: true,
			code: "SUCCESS",
			reports: reportList
		});
	} catch (error) {
		console.error("Failed to fetch reports:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 6. UPDATE REPORT STATUS (Bulk updates matching reported items) ---
moderationRoute.patch("/reports/:id/status", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const reportId = c.req.param("id");
	let body;

	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const result = updateReportStatusSchema(body);
	if (result instanceof type.errors) {
		return c.json({ success: false, code: "INVALID_STATUS", errors: result.summary }, 400);
	}

	const { status } = result;

	try {
		const [targetReport] = await database
			.select()
			.from(reports)
			.where(eq(reports.id, reportId))
			.limit(1);

		if (!targetReport) {
			return c.json({ success: false, code: "REPORT_NOT_FOUND" }, 404);
		}

		const updatedReports = await database
			.update(reports)
			.set({
				status: status as "pending" | "resolved" | "dismissed",
				updatedAt: new Date()
			})
			.where(
				and(
					eq(reports.reportedId, targetReport.reportedId),
					eq(reports.reportType, targetReport.reportType)
				)
			)
			.returning();

		return c.json({
			success: true,
			code: "REPORT_STATUS_UPDATED",
			report: updatedReports[0],
			updatedCount: updatedReports.length
		});
	} catch (error) {
		console.error("Failed to update report status:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- 7. CREATE VIOLATION / STRIKE ---
moderationRoute.post("/violations", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const result = createViolationSchema(body);
	if (result instanceof type.errors) {
		return c.json({ success: false, code: "INVALID_REQUEST_BODY", errors: result.summary }, 400);
	}

	const { userId, reportedType, reportedId, reason, moderatorReason } = result;

	if (reason.trim().length === 0) {
		return c.json({ success: false, code: "MISSING_REASON" }, 400);
	}

	if (reason.length > 2000) {
		return c.json({ success: false, code: "REASON_TOO_LONG" }, 400);
	}

	if (moderatorReason !== undefined && moderatorReason !== null) {
		if (moderatorReason.length > 2000) {
			return c.json({ success: false, code: "MODERATOR_REASON_TOO_LONG" }, 400);
		}
	}

	try {
		const [newViolation] = await database
			.insert(violations)
			.values({
				userId,
				reportedType: reportedType as "profile" | "short",
				reportedId,
				reason: reason.trim(),
				moderatorReason: typeof moderatorReason === "string" ? moderatorReason.trim() : null
			})
			.returning();

		return c.json(
			{
				success: true,
				code: "VIOLATION_CREATED",
				violation: newViolation
			},
			201
		);
	} catch (error) {
		console.error("Failed to create violation:", error);
		return c.json({ success: false, code: "CREATION_FAILED" }, 500);
	}
});

// --- 8. BAN OR UNBAN A USER ---
moderationRoute.patch("/users/:userId/ban", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const targetUserId = c.req.param("userId");
	let body;

	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const result = banUserSchema(body);
	if (result instanceof type.errors) {
		return c.json({ success: false, code: "INVALID_DATE_FORMAT", errors: result.summary }, 400);
	}

	const { bannedUntil } = result;

	let bannedDate: Date | null = null;
	if (bannedUntil !== null && bannedUntil !== undefined) {
		bannedDate = new Date(bannedUntil);
		if (isNaN(bannedDate.getTime())) {
			return c.json({ success: false, code: "INVALID_DATE_FORMAT" }, 400);
		}
	}

	try {
		const [updatedStatus] = await database
			.insert(accountModerationStatus)
			.values({
				userId: targetUserId,
				bannedUntil: bannedDate
			})
			.onConflictDoUpdate({
				target: accountModerationStatus.userId,
				set: {
					bannedUntil: bannedDate,
					updatedAt: new Date()
				}
			})
			.returning();

		return c.json({
			success: true,
			code: bannedDate ? "USER_BANNED" : "USER_UNBANNED",
			status: updatedStatus
		});
	} catch (error) {
		console.error("Failed to update user ban status:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- 9. GET TARGET USER BAN STATUS (Moderator Action) ---
moderationRoute.get("/users/:userId/ban-status", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const targetUserId = c.req.param("userId");

	try {
		const [status] = await database
			.select()
			.from(accountModerationStatus)
			.where(eq(accountModerationStatus.userId, targetUserId))
			.limit(1);

		if (!status || !status.bannedUntil) {
			return c.json({ success: true, isBanned: false, bannedUntil: null });
		}

		const now = new Date();
		const bannedUntilDate = new Date(status.bannedUntil);

		if (bannedUntilDate <= now) {
			await database
				.update(accountModerationStatus)
				.set({ bannedUntil: null, updatedAt: now })
				.where(eq(accountModerationStatus.userId, targetUserId));

			return c.json({ success: true, isBanned: false, bannedUntil: null });
		}

		return c.json({
			success: true,
			isBanned: true,
			bannedUntil: status.bannedUntil
		});
	} catch (error) {
		console.error("Failed to fetch target user ban status:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 10. GET TARGET USER VIOLATIONS (Moderator Action) ---
moderationRoute.get("/users/:userId/violations", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const targetUserId = c.req.param("userId");

	try {
		const userViolations = await database
			.select({
				id: violations.id,
				reportedType: violations.reportedType,
				reportedId: violations.reportedId,
				reason: violations.reason,
				moderatorReason: violations.moderatorReason,
				createdAt: violations.createdAt
			})
			.from(violations)
			.where(eq(violations.userId, targetUserId))
			.orderBy(desc(violations.createdAt));

		return c.json({
			success: true,
			code: "SUCCESS",
			violations: userViolations
		});
	} catch (error) {
		console.error("Failed to fetch target user violations:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});
