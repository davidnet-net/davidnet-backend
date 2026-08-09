import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { securityConfig } from "../database/schema/auth";
import { database } from "../database/client";

export type BackupCodeItem = {
	hash: string;
	used: boolean;
};

// Character set excluding lookalikes (0/O, 1/I/L)
const SAFE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateSecureCode(): string {
	let result = "";
	// We need 16 characters
	const bytes = randomBytes(16);
	for (let i = 0; i < 16; i++) {
		// Map each random byte safely to our safe character set length (32)
		const randomIndex = bytes[i] % SAFE_CHARS.length;
		result += SAFE_CHARS[randomIndex];
	}
	// Format into groups of 4: xxxx-xxxx-xxxx-xxxx
	return result.match(/.{1,4}/g)!.join("-");
}

/**
 * Generates a fresh set of plain-text backup codes in a secure, typo-safe format (16 chars, uppercase alphanumeric),
 * hashes them using Bun's native Argon2id, and prepares the array to be saved in the database.
 * * @returns An object containing `plainCodes` (to show the user ONCE)
 * and `hashedCodesObject` (to save in the database).
 */
export async function generateNewBackupCodes(count: number = 8) {
	const plainCodes: string[] = [];
	const hashedCodesObject: BackupCodeItem[] = [];

	for (let i = 0; i < count; i++) {
		const code = generateSecureCode();
		plainCodes.push(code);

		// Hash natively using Bun's built-in Argon2id
		const hash = await Bun.password.hash(code, {
			algorithm: "argon2id"
		});

		hashedCodesObject.push({ hash, used: false });
	}

	return { plainCodes, hashedCodesObject };
}

/**
 * Verifies an input backup code against a user's stored hashes.
 * If valid, it marks that specific code as used and updates the database.
 * * @returns boolean indicating if the verification and consumption were successful.
 */
export async function verifyAndConsumeBackupCode(
	userId: string,
	inputCode: string
): Promise<boolean> {
	// 1. Fetch the user's security config row
	const [config] = await database
		.select()
		.from(securityConfig)
		.where(eq(securityConfig.userId, userId));

	if (!config || !config.backupCodes) {
		return false;
	}

	// Cast the JSONB field back to our typed array structure
	const codes = config.backupCodes as BackupCodeItem[];
	let matchedIndex = -1;

	// Normalize input (trim spaces and force uppercase for uniform matching)
	const normalizedInput = inputCode.trim().toUpperCase();

	// 2. Iterate through unused backup codes and check against the input
	for (let i = 0; i < codes.length; i++) {
		if (!codes[i].used) {
			// Use Bun's native password verifier
			const isValid = await Bun.password.verify(normalizedInput, codes[i].hash);
			if (isValid) {
				matchedIndex = i;
				break;
			}
		}
	}

	// 3. If a match is found, mark it as used and persist the updated array
	if (matchedIndex !== -1) {
		codes[matchedIndex].used = true;

		await database
			.update(securityConfig)
			.set({ backupCodes: codes })
			.where(eq(securityConfig.userId, userId));

		return true;
	}

	return false;
}
