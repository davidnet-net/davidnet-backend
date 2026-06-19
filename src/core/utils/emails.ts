import { resolveMx } from "node:dns/promises";
import { join } from "node:path";
import nodemailer from "nodemailer";

// Correctly load the raw text file using Bun's API and create the Set in memory
const DOMAINS_PATH =
	process.env.NODE_ENV === "production"
		? join(process.cwd(), "constants/domains.txt")
		: join(process.cwd(), "src/core/constants/domains.txt");

const domainsFile = Bun.file(DOMAINS_PATH);
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
	} catch {
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
export const isInvalidEmail = async (email: string): Promise<string | boolean> => {
	// Regex check
	if (!isValidEmailRegex(email)) return "EMAIL_REGEX";

	// Blacklist check
	if (isEmailBlacklisted(email)) return "EMAIL_BLACKLIST";

	// Mail server check
	const isMailServerReal = await hasValidMailServer(email);
	if (!isMailServerReal) return "EMAIL_DNS";

	return false;
};

/**
 * Send an email using Nodemailer (via SMTP).
 *
 * @param recipient - Email address of the recipient.
 * @param subject - Subject line of the email.
 * @param htmlContent - HTML content to include in the email body.
 */
export async function sendEmail(
	recipient: string,
	subject: string,
	htmlContent: string
): Promise<void> {
	const emailSource = Bun.env.EMAIL;
	const emailPassword = Bun.env.EMAIL_PASSWORD;

	if (!emailSource || !emailPassword) {
		throw new Error("Email credentials are not set in environment variables");
	}

	const transporter = nodemailer.createTransport({
		host: "smtp.strato.com",
		port: 465,
		secure: true, // true for port 465, false for port 587
		auth: {
			user: emailSource,
			pass: emailPassword
		}
	});

	await transporter.sendMail({
		from: emailSource,
		to: recipient,
		subject,
		html: htmlContent
	});
}

/**
 * Processes an HTML template string and replaces placeholders {{key}} with given values.
 *
 * @param templateContent - The raw HTML string.
 * @param replacements - An object with keys and values to replace in the template.
 * @returns The processed HTML string with replacements applied.
 */
export function loadEmailTemplate(
	templateContent: string,
	replacements: Record<string, string>
): string {
	let result = templateContent;
	for (const [key, value] of Object.entries(replacements)) {
		const regex = new RegExp(`{{${key}}}`, "g");
		result = result.replace(regex, value);
	}
	return result;
}
