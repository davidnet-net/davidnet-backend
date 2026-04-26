import { database } from "../database/client";
import { signupStatus } from "../database/schema/auth";
import { isValidUuidV4 } from "./uuidvalidator";
import { eq, or, sql } from "drizzle-orm";

/**
 *
 * @param signupToken
 * @returns false if invalid OR userID string if valid
 */
export async function isValidSignupToken(
	signupToken: string | undefined
): Promise<boolean | string> {
	if (!signupToken || !isValidUuidV4(signupToken)) {
		return false;
	}

	const activeSignup = await database
		.select({ userId: signupStatus.userId })
		.from(signupStatus)
		.where(eq(signupStatus.signupToken, signupToken))
		.limit(1);

	if (activeSignup.length === 0) {
		return false;
	}

	return activeSignup[0].userId;
}
