import { Hono } from "hono";
import { feedback } from "./feedback";

export const support = new Hono();

support.route("/send-feedback", feedback);
