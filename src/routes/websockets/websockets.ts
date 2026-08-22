import { Hono } from "hono";
import { quizWs } from "./quiz";

export const websockets = new Hono();

websockets.route("/quiz", quizWs);
