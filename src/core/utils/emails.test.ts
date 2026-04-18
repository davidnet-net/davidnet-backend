import { describe, expect, test } from "bun:test";

import { isInvalidEmail } from "./emails";

describe("utils - emails", () => {
	test("Regex", async () => {
		expect(await isInvalidEmail("not-an-email")).toBe("EMAIL_REGEX");
	});

	test("Blacklist", async () => {
		expect(await isInvalidEmail("user@example.com")).toBe("EMAIL_BLACKLIST");
	});

	test("MX dns - Should success", async () => {
		const result = await isInvalidEmail("test@gmail.com");
		expect(result).toBe(false);
	});

	test("MX dns - Should fail", async () => {
		expect(await isInvalidEmail("user@thisdomaindoesnotexist12345.com")).toBe("EMAIL_DNS");
	});
});
