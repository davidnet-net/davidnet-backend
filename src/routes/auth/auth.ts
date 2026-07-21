import { Hono } from "hono";

import { login } from "./login";
import { session } from "./session";
import { signup } from "./signup";

export const auth = new Hono();

auth.route("/signup", signup);
auth.route("/login", login);
auth.route("/session", session);
