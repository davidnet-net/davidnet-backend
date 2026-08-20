import { Hono } from "hono";
import { quiz } from "./quiz/quiz";

export const apps = new Hono();

apps.route("/quiz", quiz);
