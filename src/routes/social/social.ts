import { Hono } from "hono";
import { connections } from "./connections";

export const social = new Hono();

social.route("/connections", connections);
