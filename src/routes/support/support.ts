import { Hono } from "hono";
import { feedback } from "./feedback";
import { moderationRoute } from "./moderation";

export const support = new Hono();

support.route("/send-feedback", feedback);
support.route("/moderation", moderationRoute);
