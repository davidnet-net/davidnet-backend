import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { signupSchema } from "../core/requestSchemas/auth";
import { isValidEmail } from "../core/utils/emails";

export const auth = new Hono();

auth.post("/signup", sValidator("json", signupSchema), async (c) => {
	const data = c.req.valid("json");

	const email = data.email;
	if (!(await isValidEmail(email))) {
		return c.json({ success: "false", code: "", message: "" }, 400);
	}

	const username = data.username.toLowerCase();
	const password = Bun.password.hash(data.password);

	return c.json({ message: "Auth endpoint" }, 200);
});
