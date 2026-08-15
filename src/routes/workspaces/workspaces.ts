import { Hono } from "hono";
import { select } from "./select";

export const workspaces = new Hono();

workspaces.route("/select", select);
// :workspaceId
