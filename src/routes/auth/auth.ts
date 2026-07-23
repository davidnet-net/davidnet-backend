import { Hono } from "hono";

import { login } from "./login";
import { me } from "./me";
import { preferences } from "./preferences";
import { privacy } from "./privacy";
import { session } from "./session";
import { signup } from "./signup";
import { security } from "./security";

export const auth = new Hono();

auth.route("/signup", signup);
auth.route("/login", login);
auth.route("/session", session);
auth.route("/me", me);
auth.route("/preferences", preferences);
auth.route("/privacy", privacy);
auth.route("/security", security);
