import { Hono } from "hono";
import { signup } from "./signup";

export const auth = new Hono();

auth.route("/signup", signup);
