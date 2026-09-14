import { Hono } from "hono";
import { connections } from "./connections";
import { shortsRoute } from "./shorts";

export const social = new Hono();

social.route("/connections", connections);
social.route("/shorts", shortsRoute);
