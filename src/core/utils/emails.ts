import { resolveMx } from "node:dns/promises";

// Correctly load the raw text file using Bun's API and create the Set in memory
const domainsFile = Bun.file(import.meta.dir + "/../constants/domains.txt");
const domainsText = await domainsFile.text();
const EMAILBLACKLIST = new Set(domainsText.split("\n").filter(Boolean));

/**
 * Regex
 * @param email
 */
const isValidEmailRegex = (email: string): boolean => {
	const basicEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return basicEmailRegex.test(email);
};

/**
 * Checkss email blacklist
 * @param email
 */
const isEmailBlacklisted = (email: string): boolean => {
	const domain = email.split("@")[1]?.toLowerCase();

	// If there's no domain, treat it as invalid/blacklisted
	if (!domain) return true;

	return EMAILBLACKLIST.has(domain);
};

/**
 * Checks if the domain has valid Mail Exchange (MX) records.
 * @param email
 */
const hasValidMailServer = async (email: string): Promise<boolean> => {
	const domain = email.split("@")[1];
	if (!domain) return false;

	try {
		const dnsLookup = resolveMx(domain);

		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("DNS_TIMEOUT")), 3000)
		);

		const records = await Promise.race([dnsLookup, timeout]);
		return records.length > 0;
	} catch (error) {
		/**
		 * Catches:
		 * - The domain doesn't exist (ENOTFOUND)
		 * - The domain exists but has no MX records (ENODATA)
		 */
		return false;
	}
};

/**
 * Checks the following: Regex, Blacklist, MailServer
 * @param email
 * @returns Promise<boolean> - True = Pass
 */
export const isValidEmail = async (email: string): Promise<boolean> => {
	// Regex check
	if (!isValidEmailRegex(email)) return false;

	// Blacklist check
	if (isEmailBlacklisted(email)) return false;

	// Mail server check
	const isMailServerReal = await hasValidMailServer(email);
	if (!isMailServerReal) return false;

	return true;
};
