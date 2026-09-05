import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { database } from "../../../../core/database/client";
import {
	quizzes,
	questions,
	quizCollaborators,
	rolePermissions,
	teamUserRoles
} from "../../../../core/database/schema/schema";
import {
	createQuizSchema,
	updateQuizSchema,
	addCollaboratorSchema
} from "../../../../core/requestSchemas/quiz";
import { createRateLimiter } from "../../../../middlewares/rateLimiter";
import { requirePerm } from "../../../../middlewares/requirePerm";
import type { Env } from "../../../../middlewares/requireAuth";
import { hasPermission } from "../../../../core/shared/checkPermissions";

export const quiz = new Hono<Env>();

// --- CREATE QUIZ ---
quiz.post(
	"/create",
	createRateLimiter(15, 15 * 60 * 1000),
	sValidator("json", createQuizSchema),
	requirePerm("quiz:create"),
	async (c) => {
		const data = c.req.valid("json");
		const workspaceId = c.req.param("workspaceId");

		if (!workspaceId) return c.json({ success: false }, 400);
		const teamId = c.req.param("teamId");

		const trimmedName = data.name.trim();
		if (trimmedName.length === 0 || trimmedName.length > 30) {
			return c.json({ success: false, code: "INVALID_QUIZ_NAME" }, 400);
		}

		try {
			const [newQuiz] = await database
				.insert(quizzes)
				.values({
					workspaceId,
					teamId,
					name: trimmedName
				})
				.returning();

			return c.json({
				success: true,
				code: "QUIZ_CREATED",
				quiz: newQuiz
			});
		} catch (error) {
			console.error("[Quiz API] Failed to create quiz:", error);
			return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
		}
	}
);

// --- LIST PENDING INVITES FOR THE LOGGED-IN USER ---
quiz.get("/invites", async (c) => {
	const userId = c.get("user").id;

	try {
		const pendingInvites = await database
			.select({
				quizId: quizzes.id,
				quizName: quizzes.name,
				workspaceId: quizzes.workspaceId,
				createdAt: quizCollaborators.createdAt
			})
			.from(quizCollaborators)
			.innerJoin(quizzes, eq(quizCollaborators.quizId, quizzes.id))
			.where(and(eq(quizCollaborators.userId, userId), eq(quizCollaborators.status, "pending")))
			.orderBy(desc(quizCollaborators.createdAt));

		return c.json({
			success: true,
			invites: pendingInvites
		});
	} catch (error) {
		console.error("[Quiz API] Failed to fetch invites:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- ACCEPT AN INVITE ---
quiz.post("/:quizId/collaborators/accept", async (c) => {
	const userId = c.get("user").id;
	const quizId = c.req.param("quizId");

	try {
		const [updated] = await database
			.update(quizCollaborators)
			.set({ status: "accepted" })
			.where(
				and(
					eq(quizCollaborators.quizId, quizId),
					eq(quizCollaborators.userId, userId),
					eq(quizCollaborators.status, "pending")
				)
			)
			.returning();

		if (!updated) {
			return c.json({ success: false, code: "INVITE_NOT_FOUND" }, 404);
		}

		return c.json({ success: true, code: "INVITE_ACCEPTED" });
	} catch (error) {
		console.error("[Quiz API] Failed to accept invite:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- DECLINE/DENY AN INVITE ---
quiz.delete("/:quizId/collaborators/decline", async (c) => {
	const userId = c.get("user").id;
	const quizId = c.req.param("quizId");

	try {
		const result = await database
			.delete(quizCollaborators)
			.where(
				and(
					eq(quizCollaborators.quizId, quizId),
					eq(quizCollaborators.userId, userId),
					eq(quizCollaborators.status, "pending")
				)
			)
			.returning({ id: quizCollaborators.id });

		if (result.length === 0) {
			return c.json({ success: false, code: "INVITE_NOT_FOUND" }, 404);
		}

		return c.json({ success: true, code: "INVITE_DECLINED" });
	} catch (error) {
		console.error("[Quiz API] Failed to decline invite:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- LIST QUIZZES ---
quiz.get("/", async (c) => {
	const userId = c.get("user").id;
	const workspaceId = c.req.param("workspaceId");
	if (!workspaceId) return c.json({ success: false }, 400);

	const teamId = c.req.param("teamId");

	try {
		if (teamId) {
			const quizList = await database
				.select()
				.from(quizzes)
				.where(and(eq(quizzes.workspaceId, workspaceId), eq(quizzes.teamId, teamId)))
				.orderBy(desc(quizzes.createdAt));

			return c.json({ success: true, quizzes: quizList });
		} else {
			const hasOrgWideAccess = await hasPermission({
				userId,
				workspaceId,
				permissionKey: "quiz:list"
			});

			const allowedTeamRoles = await database
				.select({ teamId: teamUserRoles.teamId })
				.from(teamUserRoles)
				.innerJoin(rolePermissions, eq(teamUserRoles.roleId, rolePermissions.roleId))
				.where(
					and(eq(teamUserRoles.userId, userId), eq(rolePermissions.permissionKey, "quiz:list"))
				);

			const allowedTeamIds = allowedTeamRoles.map((r) => r.teamId);

			const queryConditions = [];

			if (hasOrgWideAccess) {
				queryConditions.push(isNull(quizzes.teamId));
			}

			if (allowedTeamIds.length > 0) {
				queryConditions.push(inArray(quizzes.teamId, allowedTeamIds));
			}

			if (queryConditions.length === 0) {
				return c.json({ success: true, quizzes: [] });
			}

			const quizList = await database
				.select()
				.from(quizzes)
				.where(and(eq(quizzes.workspaceId, workspaceId), or(...queryConditions)))
				.orderBy(desc(quizzes.createdAt));

			return c.json({
				success: true,
				quizzes: quizList
			});
		}
	} catch (error) {
		console.error("[Quiz API] Failed to fetch quizzes:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

/// --- LIST SHARED QUIZZES (Global across workspaces) ---
quiz.get("/shared", async (c) => {
	const userId = c.get("user").id;

	try {
		const sharedQuizList = await database
			.select({
				quiz: quizzes
			})
			.from(quizCollaborators)
			.innerJoin(quizzes, eq(quizCollaborators.quizId, quizzes.id))
			.where(and(eq(quizCollaborators.userId, userId), eq(quizCollaborators.status, "accepted")))
			.orderBy(desc(quizzes.createdAt));

		return c.json({
			success: true,
			quizzes: sharedQuizList.map((row) => row.quiz)
		});
	} catch (error) {
		console.error("[Quiz API] Failed to fetch shared quizzes:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- GET SINGLE QUIZ DETAILS ---
quiz.get("/:quizId", requirePerm("quiz:read"), async (c) => {
	const workspaceId = c.req.param("workspaceId");
	const teamId = c.req.param("teamId");
	const quizId = c.req.param("quizId");

	if (!workspaceId || !quizId) return c.json({ success: false }, 400);

	try {
		const [targetQuiz] = await database
			.select()
			.from(quizzes)
			.where(
				and(
					eq(quizzes.id, quizId),
					eq(quizzes.workspaceId, workspaceId),
					teamId ? eq(quizzes.teamId, teamId) : isNull(quizzes.teamId)
				)
			)
			.limit(1);

		if (!targetQuiz) {
			return c.json({ success: false, code: "QUIZ_NOT_FOUND" }, 404);
		}

		const quizQuestions = await database
			.select()
			.from(questions)
			.where(eq(questions.quizId, quizId))
			.orderBy(questions.position);

		return c.json({
			success: true,
			quiz: targetQuiz,
			questions: quizQuestions
		});
	} catch (error) {
		console.error("[Quiz API] Failed to fetch single quiz:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- UPDATE QUIZ METADATA ---
quiz.patch(
	"/:quizId",
	sValidator("json", updateQuizSchema),
	requirePerm("quiz:manage"),
	async (c) => {
		const data = c.req.valid("json");
		const workspaceId = c.req.param("workspaceId");
		const teamId = c.req.param("teamId");
		const quizId = c.req.param("quizId");

		if (!workspaceId || !quizId) return c.json({ success: false }, 400);

		let trimmedName: string | undefined = undefined;
		if (data.name !== undefined) {
			trimmedName = data.name.trim();
			if (trimmedName.length === 0 || trimmedName.length > 30) {
				return c.json({ success: false, code: "INVALID_QUIZ_NAME" }, 400);
			}
		}

		try {
			const [updatedQuiz] = await database
				.update(quizzes)
				.set({
					...(trimmedName !== undefined ? { name: trimmedName } : {}),
					updatedAt: new Date()
				})
				.where(
					and(
						eq(quizzes.id, quizId),
						eq(quizzes.workspaceId, workspaceId),
						teamId ? eq(quizzes.teamId, teamId) : isNull(quizzes.teamId)
					)
				)
				.returning();

			if (!updatedQuiz) {
				return c.json({ success: false, code: "QUIZ_NOT_FOUND" }, 404);
			}

			return c.json({
				success: true,
				code: "QUIZ_UPDATED",
				quiz: updatedQuiz
			});
		} catch (error) {
			console.error("[Quiz API] Failed to update quiz:", error);
			return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
		}
	}
);

// --- DELETE QUIZ ---
quiz.delete("/:quizId", requirePerm("quiz:manage"), async (c) => {
	const workspaceId = c.req.param("workspaceId");
	const teamId = c.req.param("teamId");
	const quizId = c.req.param("quizId");

	if (!workspaceId || !quizId) {
		return c.json({ success: false, code: "BAD_REQUEST" }, 400);
	}

	try {
		const deleteFilter = and(
			eq(quizzes.id, quizId),
			eq(quizzes.workspaceId, workspaceId),
			teamId ? eq(quizzes.teamId, teamId) : isNull(quizzes.teamId)
		);

		const result = await database
			.delete(quizzes)
			.where(deleteFilter)
			.returning({ deletedId: quizzes.id });

		if (result.length === 0) {
			return c.json({ success: false, code: "QUIZ_NOT_FOUND" }, 404);
		}

		return c.json({
			success: true,
			code: "QUIZ_DELETED",
			deletedId: result[0].deletedId
		});
	} catch (error) {
		console.error("[Quiz API] Failed to delete quiz:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- LIST COLLABORATORS FOR A QUIZ ---
quiz.get("/:quizId/collaborators", requirePerm("quiz:manage"), async (c) => {
	const quizId = c.req.param("quizId");
	try {
		const collaborators = await database
			.select()
			.from(quizCollaborators)
			.where(eq(quizCollaborators.quizId, quizId));

		return c.json({ success: true, collaborators });
	} catch (error) {
		console.error("[Quiz API] Failed to fetch collaborators:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- ADD A COLLABORATOR (SERVER-ENFORCED PENDING INVITE) ---
quiz.post(
	"/:quizId/collaborators",
	sValidator("json", addCollaboratorSchema),
	requirePerm("quiz:manage"),
	async (c) => {
		const data = c.req.valid("json");
		const quizId = c.req.param("quizId");
		const currentUserId = c.get("user").id; // Get the logged-in user

		// Prevent inviting yourself
		if (data.userId === currentUserId) {
			return c.json({ success: false, code: "CANNOT_INVITE_SELF" }, 400);
		}

		try {
			const [existing] = await database
				.select()
				.from(quizCollaborators)
				.where(and(eq(quizCollaborators.quizId, quizId), eq(quizCollaborators.userId, data.userId)))
				.limit(1);

			if (existing) {
				return c.json({ success: false, code: "COLLABORATOR_ALREADY_EXISTS" }, 400);
			}

			const [newInvite] = await database
				.insert(quizCollaborators)
				.values({
					quizId,
					userId: data.userId,
					status: "pending"
				})
				.returning();

			return c.json({ success: true, code: "INVITATION_SENT", collaborator: newInvite });
		} catch (error) {
			console.error("[Quiz API] Failed to send invite:", error);
			return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
		}
	}
);

// --- STOP COLLABORATING (Self-Removal) ---
quiz.delete("/:quizId/collaborators/me", async (c) => {
	const userId = c.get("user").id;
	const quizId = c.req.param("quizId");

	try {
		const result = await database
			.delete(quizCollaborators)
			.where(and(eq(quizCollaborators.quizId, quizId), eq(quizCollaborators.userId, userId)))
			.returning({ id: quizCollaborators.id });

		if (result.length === 0) {
			return c.json({ success: false, code: "COLLABORATION_NOT_FOUND" }, 404);
		}

		return c.json({ success: true, code: "STOPPED_COLLABORATING" });
	} catch (error) {
		console.error("[Quiz API] Failed to stop collaborating:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});

// --- REMOVE A COLLABORATOR OR CANCEL INVITE ---
quiz.delete("/:quizId/collaborators/:userId", requirePerm("quiz:manage"), async (c) => {
	const quizId = c.req.param("quizId");
	const targetUserId = c.req.param("userId");

	try {
		const result = await database
			.delete(quizCollaborators)
			.where(and(eq(quizCollaborators.quizId, quizId), eq(quizCollaborators.userId, targetUserId)))
			.returning({ id: quizCollaborators.id });

		if (result.length === 0) {
			return c.json({ success: false, code: "COLLABORATOR_NOT_FOUND" }, 404);
		}

		return c.json({ success: true, code: "COLLABORATOR_REMOVED" });
	} catch (error) {
		console.error("[Quiz API] Failed to remove collaborator:", error);
		return c.json({ success: false, code: "INTERNAL_SERVER_ERROR" }, 500);
	}
});
