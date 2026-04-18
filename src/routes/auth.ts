import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import { database } from "../core/database/client";
import { users } from "../core/database/schema/schema";
import { signupSchema } from "../core/requestSchemas/auth";
import { isInvalidEmail } from "../core/utils/emails";

export const auth = new Hono();

auth.post("/signup", sValidator("json", signupSchema), async (c) => {
	const data = c.req.valid("json");

	// Email validation
	const email = data.email.trim().toLowerCase();
	const isInvalidEmailResult = await isInvalidEmail(email);
	if (isInvalidEmailResult) {
		return c.json({ success: false, code: isInvalidEmailResult }, 400);
	}

	// Password validation
	if (data.password.length < 8) {
		return c.json({ success: false, code: "PASSWORD_SHORT" }, 400);
	}

	// HIBP check
	try {
		const sha1Hasher = new Bun.CryptoHasher("sha1");
		sha1Hasher.update(data.password);
		const fullHash = sha1Hasher.digest("hex").toUpperCase();

		const prefix = fullHash.substring(0, 5);
		const suffix = fullHash.substring(5);

		const hibpResponse = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
		if (hibpResponse.ok) {
			const text = await hibpResponse.text();
			const isPwned = text.split("\n").some((line) => {
				const [hashSuffix, count] = line.split(":");
				return hashSuffix === suffix && parseInt(count) > 0;
			});
			if (isPwned) {
				return c.json({ success: false, code: "PASSWORD_PWNED" }, 400);
			}
		}
	} catch (e) {
		// FAIL SIlENT: So that we dont need the HIBP for the signup
		console.error("[auth]: HIBP ERROR", e);
	}

	const username = data.username.trim().toLowerCase();

	const password = await Bun.password.hash(data.password, {
		algorithm: "argon2id",
		memoryCost: 19456,
		timeCost: 2
	});

	// Validation complete
	// - username
	// - password
	// - email

	await database.insert(users).values({
		username: username,
		password: password,
		email: email,
		displayName: username
	});

	const allUsers = await database.select().from(users);
	console.log(allUsers);
	return c.json({ success: true, message: "User created" }, 201);
});
