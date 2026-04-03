import { Hono } from "hono";

export const auth = new Hono();

auth.get("/", async (c) => {
	return c.json({ message: "Auth endpoint" }, 200);
});
