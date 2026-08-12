import { eq, and, or } from "drizzle-orm";
import { Hono } from "hono";

import { database } from "../../core/database/client";
import { users } from "../../core/database/schema/schema";
import { type Env, requireAuth } from "../../middlewares/requireAuth";
import { sValidator } from "@hono/standard-validator";
import {
	requestedUserSchema,
	connectionIdSchema,
	blockIdSchema
} from "../../core/requestSchemas/connections";
import { userConnections, userBlocks } from "../../core/database/schema/connections";

export const connections = new Hono<Env>();

connections.get("/", requireAuth, async (c) => {
	const userID = c.get("user").id;

	// 1. Fetch all connections involving the user
	const allConnections = await database
		.select()
		.from(userConnections)
		.where(or(eq(userConnections.senderId, userID), eq(userConnections.receiverId, userID)));

	// 2. Fetch all blocks made by the user
	const blocks = await database.select().from(userBlocks).where(eq(userBlocks.userId, userID));

	const friends: any[] = [];
	const incoming: any[] = [];
	const outgoing: any[] = [];

	// 3. Categorize connections based on status and sender/receiver roles
	for (const conn of allConnections) {
		const otherUserId = conn.senderId === userID ? conn.receiverId : conn.senderId;

		if (conn.status === "accepted") {
			friends.push({ connectionId: conn.id, userId: otherUserId, updatedAt: conn.updatedAt });
		} else if (conn.status === "pending") {
			if (conn.receiverId === userID) {
				incoming.push({ connectionId: conn.id, userId: conn.senderId, createdAt: conn.createdAt });
			} else {
				outgoing.push({
					connectionId: conn.id,
					userId: conn.receiverId,
					createdAt: conn.createdAt
				});
			}
		}
	}

	// 4. Format blocked users list
	const blockedUsers = blocks.map((block) => ({
		blockId: block.id,
		userId: block.blockedId,
		createdAt: block.createdAt
	}));

	return c.json({
		code: "success",
		success: true,
		friends,
		incoming,
		outgoing,
		blocked: blockedUsers
	});
});

connections.get("/status", requireAuth, async (c) => {
	const userID = c.get("user").id;
	const requestedUserID = c.req.query("user");

	if (!requestedUserID) {
		return c.json(
			{
				code: "NO_USER_GIVEN",
				success: false
			},
			400
		);
	}

	if (userID === requestedUserID) {
		return c.json(
			{
				code: "SELF_CONNECTION_ERROR",
				success: false,
				error: "Cannot check connection status with yourself"
			},
			400
		);
	}

	const existingConnection = await database
		.select()
		.from(userConnections)
		.where(
			or(
				and(eq(userConnections.senderId, userID), eq(userConnections.receiverId, requestedUserID)),
				and(eq(userConnections.senderId, requestedUserID), eq(userConnections.receiverId, userID))
			)
		)
		.limit(1);

	let status: "accepted" | "rejected" | "pending" | "none" = "none";

	if (existingConnection.length > 0) {
		status = existingConnection[0].status;
	}

	return c.json({
		code: "success",
		success: true,
		status
	});
});

connections.post(
	"/send-connection-request",
	requireAuth,
	sValidator("json", requestedUserSchema),
	async (c) => {
		const userID = c.get("user").id;
		const { requestedUserID } = c.req.valid("json");

		if (userID === requestedUserID) {
			return c.json(
				{
					code: "SELF_CONNECTION_ERROR",
					success: false,
					error: "Cannot send connection request to yourself"
				},
				400
			);
		}

		const existing = await database
			.select()
			.from(userConnections)
			.where(
				or(
					and(
						eq(userConnections.senderId, userID),
						eq(userConnections.receiverId, requestedUserID)
					),
					and(eq(userConnections.senderId, requestedUserID), eq(userConnections.receiverId, userID))
				)
			)
			.limit(1);

		if (existing.length > 0) {
			const conn = existing[0];
			if (conn.status === "accepted" || conn.status === "pending") {
				return c.json(
					{
						code: `CONNECTION_ALREADY_${conn.status.toUpperCase()}`,
						success: false,
						error: `Connection already ${conn.status}`
					},
					400
				);
			}
			if (conn.status === "rejected") {
				const rejectedAt = new Date(conn.updatedAt).getTime();
				const twentyFourHours = 24 * 60 * 60 * 1000;
				const now = Date.now();

				if (now - rejectedAt < twentyFourHours) {
					return c.json(
						{
							code: "REJECTION_COOLDOWN_ACTIVE",
							success: false,
							error: "You must wait 24 hours after a rejection before sending a new request."
						},
						400
					);
				}

				await database
					.update(userConnections)
					.set({
						senderId: userID,
						receiverId: requestedUserID,
						status: "pending",
						updatedAt: new Date()
					})
					.where(eq(userConnections.id, conn.id));

				return c.json({ code: "success", success: true, message: "Connection request sent" });
			}
		}

		await database.insert(userConnections).values({
			senderId: userID,
			receiverId: requestedUserID,
			status: "pending"
		});

		return c.json({ code: "success", success: true, message: "Connection request sent" });
	}
);

connections.post(
	"/accept-connection-request",
	requireAuth,
	sValidator("json", requestedUserSchema),
	async (c) => {
		const userID = c.get("user").id;
		const { requestedUserID } = c.req.valid("json");

		const result = await database
			.update(userConnections)
			.set({ status: "accepted", updatedAt: new Date() })
			.where(
				and(
					eq(userConnections.senderId, requestedUserID),
					eq(userConnections.receiverId, userID),
					eq(userConnections.status, "pending")
				)
			)
			.returning();

		if (result.length === 0) {
			return c.json(
				{
					code: "CONNECTION_NOT_FOUND",
					success: false,
					error: "No pending connection request found from this user"
				},
				404
			);
		}

		return c.json({ code: "success", success: true, message: "Connection accepted" });
	}
);

connections.post(
	"/reject-connection-request",
	requireAuth,
	sValidator("json", requestedUserSchema),
	async (c) => {
		const userID = c.get("user").id;
		const { requestedUserID } = c.req.valid("json");

		const result = await database
			.update(userConnections)
			.set({ status: "rejected", updatedAt: new Date() })
			.where(
				and(
					eq(userConnections.senderId, requestedUserID),
					eq(userConnections.receiverId, userID),
					eq(userConnections.status, "pending")
				)
			)
			.returning();

		if (result.length === 0) {
			return c.json(
				{
					code: "CONNECTION_NOT_FOUND",
					success: false,
					error: "No pending connection request found from this user"
				},
				404
			);
		}

		return c.json({ code: "success", success: true, message: "Connection rejected" });
	}
);

connections.post("/block", requireAuth, sValidator("json", requestedUserSchema), async (c) => {
	const userID = c.get("user").id;
	const { requestedUserID } = c.req.valid("json");

	if (userID === requestedUserID) {
		return c.json(
			{ code: "SELF_BLOCK_ERROR", success: false, error: "Cannot block yourself" },
			400
		);
	}

	await database
		.insert(userBlocks)
		.values({
			userId: userID,
			blockedId: requestedUserID
		})
		.onConflictDoNothing();

	await database
		.delete(userConnections)
		.where(
			or(
				and(eq(userConnections.senderId, userID), eq(userConnections.receiverId, requestedUserID)),
				and(eq(userConnections.senderId, requestedUserID), eq(userConnections.receiverId, userID))
			)
		);

	return c.json({ code: "success", success: true, message: "User blocked" });
});

connections.post("/unblock", requireAuth, sValidator("json", requestedUserSchema), async (c) => {
	const userID = c.get("user").id;
	const { requestedUserID } = c.req.valid("json");

	await database
		.delete(userBlocks)
		.where(and(eq(userBlocks.userId, userID), eq(userBlocks.blockedId, requestedUserID)));

	return c.json({ code: "success", success: true, message: "User unblocked" });
});
