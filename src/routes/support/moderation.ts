import { and, desc, eq, gt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { type } from "arktype";

import { database } from "../../core/database/client";
import {
	accountModerationStatus,
	internalAccess,
	reports,
	users,
	shorts,
	violations,
	communityGame,
	banEvents,
	userIpLog,
	bannedIps,
	signupStatus
} from "../../core/database/schema/schema";
import {
	createReportSchema,
	updateReportStatusSchema,
	banUserSchema,
	createViolationSchema,
	editViolationSchema,
	banIpSchema
} from "../../core/requestSchemas/moderation";
import { collectAuth } from "../../middlewares/collectAuth";
import { requireAuth, type Env } from "../../middlewares/requireAuth";
import { notifyActivity } from "../../core/shared/activityWebhook";

export const moderationRoute = new Hono<Env>();

// The profile page passes whatever identifier is in its URL slug, which per the
// site-wide profile link convention is a username, not a userId - even though the
// report payload field is named "reportedId" (same situation as social/connections.ts's
// "requestedUserID"). Comparing that directly against the uuid-typed userId column
// throws a Postgres type error, so it needs resolving first.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
	let resolvedReportedId = reportedId;

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
			const isUuid = UUID_REGEX.test(reportedId);
			const [targetUser] = await database
				.select({ userId: users.userId })
				.from(users)
				.where(isUuid ? eq(users.userId, reportedId) : eq(users.username, reportedId))
				.limit(1);

			if (!targetUser) {
				return c.json({ success: false, code: "USER_NOT_FOUND" }, 404);
			}
			actualReportedUserId = targetUser.userId;
			resolvedReportedId = targetUser.userId;
		} else if (reportType === "game") {
			const [targetGame] = await database
				.select({ userId: communityGame.userId })
				.from(communityGame)
				.where(eq(communityGame.id, reportedId))
				.limit(1);

			if (!targetGame) {
				return c.json({ success: false, code: "GAME_NOT_FOUND" }, 404);
			}
			actualReportedUserId = targetGame.userId;
		} else {
			return c.json({ success: false, code: "INVALID_REPORT_TYPE" }, 400);
		}

		const [newReport] = await database
			.insert(reports)
			.values({
				reporterId,
				reportedUserId: actualReportedUserId,
				reportType: reportType as "profile" | "short" | "game",
				reportedId: resolvedReportedId,
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
		return c.json({ success: false, code: "REPORT_MISSION_FAILED" }, 500);
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

// --- 5. GET REPORTS LIST (Met volledige profiel info via alias) ---
moderationRoute.get("/reports", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const statusQuery = c.req.query("status");

	try {
		const reportedUser = alias(users, "reported_user");

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
				reportedUserId: reports.reportedUserId,
				reportedUsername: reportedUser.username,
				reportedDisplayName: reportedUser.displayName
			})
			.from(reports)
			.innerJoin(users, eq(reports.reporterId, users.userId))
			.innerJoin(reportedUser, eq(reports.reportedUserId, reportedUser.userId))
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

// --- 6. UPDATE REPORT STATUS ---
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
				reportedType: reportedType as "profile" | "short" | "game",
				reportedId,
				reason: reason.trim(),
				moderatorReason: typeof moderatorReason === "string" ? moderatorReason.trim() : null
			})
			.returning();

		void notifyActivity("⚠️ Violation issued", moderatorId, {
			"Violation ID": newViolation.id,
			"Target User ID": userId,
			Type: reportedType
		});

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

// --- 7B. EDIT A VIOLATION ---
moderationRoute.patch("/violations/:id", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const violationId = c.req.param("id");
	let body;

	try {
		body = await c.req.json();
	} catch {
		return c.json({ success: false, code: "INVALID_JSON" }, 400);
	}

	const result = editViolationSchema(body);
	if (result instanceof type.errors) {
		return c.json({ success: false, code: "INVALID_REQUEST_BODY", errors: result.summary }, 400);
	}

	const { reason, moderatorReason } = result;

	if (reason === undefined && moderatorReason === undefined) {
		return c.json({ success: false, code: "NO_FIELDS_TO_UPDATE" }, 400);
	}

	if (reason !== undefined && reason.trim().length === 0) {
		return c.json({ success: false, code: "MISSING_REASON" }, 400);
	}

	if (reason !== undefined && reason.length > 2000) {
		return c.json({ success: false, code: "REASON_TOO_LONG" }, 400);
	}

	if (typeof moderatorReason === "string" && moderatorReason.length > 2000) {
		return c.json({ success: false, code: "MODERATOR_REASON_TOO_LONG" }, 400);
	}

	try {
		const [existing] = await database
			.select()
			.from(violations)
			.where(eq(violations.id, violationId))
			.limit(1);

		if (!existing) {
			return c.json({ success: false, code: "VIOLATION_NOT_FOUND" }, 404);
		}

		const [updatedViolation] = await database
			.update(violations)
			.set({
				...(reason !== undefined ? { reason: reason.trim() } : {}),
				...(moderatorReason !== undefined
					? { moderatorReason: moderatorReason === null ? null : moderatorReason.trim() }
					: {}),
				updatedAt: new Date()
			})
			.where(eq(violations.id, violationId))
			.returning();

		void notifyActivity("✏️ Violation edited", moderatorId, {
			"Violation ID": violationId,
			"Target User ID": existing.userId
		});

		return c.json({ success: true, code: "VIOLATION_UPDATED", violation: updatedViolation });
	} catch (error) {
		console.error("Failed to edit violation:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- 7C. DELETE A VIOLATION ---
moderationRoute.delete("/violations/:id", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const violationId = c.req.param("id");

	try {
		const [existing] = await database
			.select()
			.from(violations)
			.where(eq(violations.id, violationId))
			.limit(1);

		if (!existing) {
			return c.json({ success: false, code: "VIOLATION_NOT_FOUND" }, 404);
		}

		await database.delete(violations).where(eq(violations.id, violationId));

		void notifyActivity("🗑️ Violation deleted", moderatorId, {
			"Violation ID": violationId,
			"Target User ID": existing.userId
		});

		return c.json({ success: true, code: "VIOLATION_DELETED" });
	} catch (error) {
		console.error("Failed to delete violation:", error);
		return c.json({ success: false, code: "DELETE_FAILED" }, 500);
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

	const { bannedUntil, violationId, reason } = result;

	let bannedDate: Date | null = null;
	if (bannedUntil !== null && bannedUntil !== undefined) {
		bannedDate = new Date(bannedUntil);
		if (isNaN(bannedDate.getTime())) {
			return c.json({ success: false, code: "INVALID_DATE_FORMAT" }, 400);
		}
	}

	// DSA Art. 17 requires a statement of reasons whenever we restrict an account - so an actual
	// ban (not an unban) must always resolve to a violation: either an existing one the moderator
	// picked, or a fresh one created from the typed-in reason. Unbanning needs neither.
	let resolvedViolationId: string | null = null;
	let resolvedReason: string | null = null;

	if (bannedDate !== null) {
		if (violationId) {
			const [existingViolation] = await database
				.select()
				.from(violations)
				.where(and(eq(violations.id, violationId), eq(violations.userId, targetUserId)))
				.limit(1);

			if (!existingViolation) {
				return c.json({ success: false, code: "VIOLATION_NOT_FOUND" }, 400);
			}

			resolvedViolationId = existingViolation.id;
			resolvedReason = existingViolation.moderatorReason ?? existingViolation.reason;
		} else if (reason && reason.trim().length > 0) {
			const [newViolation] = await database
				.insert(violations)
				.values({
					userId: targetUserId,
					reportedType: "profile",
					reportedId: targetUserId,
					reason: reason.trim()
				})
				.returning();

			resolvedViolationId = newViolation.id;
			resolvedReason = newViolation.reason;
		} else {
			return c.json({ success: false, code: "MISSING_REASON_OR_VIOLATION" }, 400);
		}
	}

	try {
		const metadata = c.get("metadata");

		const updatedStatus = await database.transaction(async (tx) => {
			const [status] = await tx
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

			await tx.insert(banEvents).values({
				userId: targetUserId,
				moderatorId,
				action: bannedDate ? "ban" : "unban",
				bannedUntil: bannedDate,
				violationId: resolvedViolationId,
				reason: resolvedReason,
				moderatorIp: metadata?.ip ?? null,
				moderatorCountryCode: metadata?.countryCode ?? null
			});

			// Hiding is one-directional: a ban cascades to hide all of the user's content, but
			// unbanning never auto-restores it - each piece stays hidden until a moderator reviews
			// and unhides it individually.
			if (bannedDate) {
				await tx.update(shorts).set({ isModerated: true }).where(eq(shorts.userId, targetUserId));
				await tx
					.update(communityGame)
					.set({ isModerated: true })
					.where(eq(communityGame.userId, targetUserId));
			}

			return status;
		});

		void notifyActivity(bannedDate ? "🔨 User banned" : "✅ User unbanned", moderatorId, {
			"Target User ID": targetUserId,
			"Banned Until": bannedDate ? bannedDate.toISOString() : null,
			Reason: resolvedReason,
			"Violation ID": resolvedViolationId
		});

		return c.json({
			success: true,
			code: bannedDate ? "USER_BANNED" : "USER_UNBANNED",
			status: updatedStatus,
			violationId: resolvedViolationId
		});
	} catch (error) {
		console.error("Failed to update user ban status:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- 9. GET TARGET USER BAN STATUS ---
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

// --- 10. GET TARGET USER VIOLATIONS ---
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

// --- 11. GET ALL PLATFORM VIOLATIONS ---
moderationRoute.get("/violations/all", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	try {
		const allViolations = await database
			.select({
				id: violations.id,
				userId: violations.userId,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				reportedType: violations.reportedType,
				reportedId: violations.reportedId,
				reason: violations.reason,
				moderatorReason: violations.moderatorReason,
				createdAt: violations.createdAt
			})
			.from(violations)
			.innerJoin(users, eq(violations.userId, users.userId))
			.orderBy(desc(violations.createdAt));

		return c.json({
			success: true,
			code: "SUCCESS",
			violations: allViolations
		});
	} catch (error) {
		console.error("Failed to fetch platform violations:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 12. GET ALL ACTIVE PLATFORM BANS ---
moderationRoute.get("/bans/all", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	try {
		const now = new Date();
		const activeBans = await database
			.select({
				userId: accountModerationStatus.userId,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				reportTrustScore: accountModerationStatus.reportTrustScore,
				bannedUntil: accountModerationStatus.bannedUntil,
				updatedAt: accountModerationStatus.updatedAt
			})
			.from(accountModerationStatus)
			.innerJoin(users, eq(accountModerationStatus.userId, users.userId))
			.where(gt(accountModerationStatus.bannedUntil, now))
			.orderBy(desc(accountModerationStatus.updatedAt));

		return c.json({
			success: true,
			code: "SUCCESS",
			bannedUsers: activeBans
		});
	} catch (error) {
		console.error("Failed to fetch active platform bans:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 12B. GET BAN/UNBAN HISTORY FOR A USER (statement-of-reasons audit trail) ---
moderationRoute.get("/users/:userId/ban-events", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const targetUserId = c.req.param("userId");

	try {
		const moderatorUser = alias(users, "moderator_user");

		const events = await database
			.select({
				id: banEvents.id,
				action: banEvents.action,
				bannedUntil: banEvents.bannedUntil,
				violationId: banEvents.violationId,
				reason: banEvents.reason,
				moderatorId: banEvents.moderatorId,
				moderatorUsername: moderatorUser.username,
				createdAt: banEvents.createdAt
			})
			.from(banEvents)
			.innerJoin(moderatorUser, eq(banEvents.moderatorId, moderatorUser.userId))
			.where(eq(banEvents.userId, targetUserId))
			.orderBy(desc(banEvents.createdAt));

		return c.json({ success: true, code: "SUCCESS", events });
	} catch (error) {
		console.error("Failed to fetch ban events:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// ============================================================================
// IP MODERATION (requires internalAccess AND supportAccess)
// ============================================================================

// --- IP-1. GET IPs A USER HAS CONNECTED FROM ---
moderationRoute.get("/users/:userId/ips", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const targetUserId = c.req.param("userId");

	try {
		const ips = await database
			.select({
				ip: userIpLog.ip,
				countryCode: userIpLog.countryCode,
				userAgent: userIpLog.userAgent,
				lastSeenAt: userIpLog.lastSeenAt,
				createdAt: userIpLog.createdAt,
				isBanned: bannedIps.ip
			})
			.from(userIpLog)
			.leftJoin(bannedIps, eq(userIpLog.ip, bannedIps.ip))
			.where(eq(userIpLog.userId, targetUserId))
			.orderBy(desc(userIpLog.lastSeenAt));

		return c.json({
			success: true,
			code: "SUCCESS",
			ips: ips.map((row) => ({ ...row, isBanned: row.isBanned !== null }))
		});
	} catch (error) {
		console.error("Failed to fetch user IPs:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- IP-2. GET USERS LINKED TO AN IP ---
moderationRoute.get("/ips/:ip/users", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const ip = c.req.param("ip");

	try {
		const linkedUsers = await database
			.select({
				userId: users.userId,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				lastSeenAt: userIpLog.lastSeenAt,
				userAgent: userIpLog.userAgent
			})
			.from(userIpLog)
			.innerJoin(users, eq(userIpLog.userId, users.userId))
			.where(eq(userIpLog.ip, ip))
			.orderBy(desc(userIpLog.lastSeenAt));

		return c.json({ success: true, code: "SUCCESS", users: linkedUsers });
	} catch (error) {
		console.error("Failed to fetch users for IP:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- IP-3. GET ALL BANNED IPs ---
moderationRoute.get("/ips/banned", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	try {
		const moderatorUser = alias(users, "moderator_user");

		const banned = await database
			.select({
				ip: bannedIps.ip,
				reason: bannedIps.reason,
				createdAt: bannedIps.createdAt,
				moderatorUsername: moderatorUser.username
			})
			.from(bannedIps)
			.innerJoin(moderatorUser, eq(bannedIps.moderatorId, moderatorUser.userId))
			.orderBy(desc(bannedIps.createdAt));

		return c.json({ success: true, code: "SUCCESS", bannedIps: banned });
	} catch (error) {
		console.error("Failed to fetch banned IPs:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- IP-4. BAN AN IP (blocks it across the whole backend, not just this user's actions) ---
moderationRoute.post("/ips/:ip/ban", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const ip = c.req.param("ip").trim();
	if (!ip) {
		return c.json({ success: false, code: "INVALID_IP" }, 400);
	}

	let body;
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}

	const result = banIpSchema(body);
	if (result instanceof type.errors) {
		return c.json({ success: false, code: "INVALID_REQUEST_BODY", errors: result.summary }, 400);
	}

	try {
		const [banned] = await database
			.insert(bannedIps)
			.values({ ip, moderatorId, reason: result.reason?.trim() || null })
			.onConflictDoUpdate({
				target: bannedIps.ip,
				set: { reason: result.reason?.trim() || null, moderatorId }
			})
			.returning();

		void notifyActivity("🚫 IP banned", moderatorId, { IP: ip, Reason: banned.reason });

		return c.json({ success: true, code: "IP_BANNED", bannedIp: banned });
	} catch (error) {
		console.error("Failed to ban IP:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- IP-5. UNBAN AN IP ---
moderationRoute.delete("/ips/:ip/ban", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const ip = c.req.param("ip").trim();

	try {
		await database.delete(bannedIps).where(eq(bannedIps.ip, ip));

		void notifyActivity("✅ IP unbanned", moderatorId, { IP: ip });

		return c.json({ success: true, code: "IP_UNBANNED" });
	} catch (error) {
		console.error("Failed to unban IP:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- 13. GET ALL SHORTS (CHRONOLOGICAL, MODERATOR BROWSER) ---
moderationRoute.get("/shorts/all", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

	try {
		const allShorts = await database
			.select({
				id: shorts.id,
				userId: shorts.userId,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				title: shorts.title,
				videoUrl: shorts.videoUrl,
				views: shorts.views,
				likesCount: shorts.likesCount,
				isModerated: shorts.isModerated,
				createdAt: shorts.createdAt
			})
			.from(shorts)
			.innerJoin(users, eq(shorts.userId, users.userId))
			.orderBy(desc(shorts.createdAt))
			.limit(limit)
			.offset(offset);

		return c.json({
			success: true,
			code: "SUCCESS",
			shorts: allShorts,
			hasMore: allShorts.length === limit
		});
	} catch (error) {
		console.error("Failed to fetch all shorts:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 13B. GET ALL COMMUNITY GAMES (CHRONOLOGICAL, MODERATOR BROWSER) ---
// Lets a moderator hide a game (or issue a violation / ban its creator) proactively, without
// needing an open report to drive them into the report-review modal first.
moderationRoute.get("/games/all", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

	try {
		const allGames = await database
			.select({
				id: communityGame.id,
				userId: communityGame.userId,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				title: communityGame.title,
				description: communityGame.description,
				likesCount: communityGame.likesCount,
				isModerated: communityGame.isModerated,
				isAiGenerated: communityGame.isAiGenerated,
				createdAt: communityGame.createdAt
			})
			.from(communityGame)
			.innerJoin(users, eq(communityGame.userId, users.userId))
			.orderBy(desc(communityGame.createdAt))
			.limit(limit)
			.offset(offset);

		return c.json({
			success: true,
			code: "SUCCESS",
			games: allGames,
			hasMore: allGames.length === limit
		});
	} catch (error) {
		console.error("Failed to fetch all community games:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});

// --- 14. GET ALL ACCOUNTS (CHRONOLOGICAL, MODERATOR BROWSER) ---
moderationRoute.get("/accounts/all", requireAuth, async (c) => {
	const moderatorId = c.get("user").id;

	if (!(await isModerator(moderatorId))) {
		return c.json({ success: false, code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS" }, 403);
	}

	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

	try {
		const allAccounts = await database
			.select({
				userId: users.userId,
				username: users.username,
				displayName: users.displayName,
				avatarUrl: users.avatarUrl,
				email: users.email,
				emailVerified: signupStatus.emailVerified,
				countryCode: users.countryCode,
				createdAt: users.createdAt,
				bannedUntil: accountModerationStatus.bannedUntil,
				reportTrustScore: accountModerationStatus.reportTrustScore,
				internalAccess: internalAccess.internalAccess,
				supportAccess: internalAccess.supportAccess,
				developerAccess: internalAccess.developerAccess
			})
			.from(users)
			.leftJoin(accountModerationStatus, eq(users.userId, accountModerationStatus.userId))
			.leftJoin(internalAccess, eq(users.userId, internalAccess.userId))
			.leftJoin(signupStatus, eq(users.userId, signupStatus.userId))
			.orderBy(desc(users.createdAt))
			.limit(limit)
			.offset(offset);

		return c.json({
			success: true,
			code: "SUCCESS",
			accounts: allAccounts,
			hasMore: allAccounts.length === limit
		});
	} catch (error) {
		console.error("Failed to fetch all accounts:", error);
		return c.json({ success: false, code: "FETCH_FAILED" }, 500);
	}
});
