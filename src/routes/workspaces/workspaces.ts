import { Hono } from "hono";
import { select } from "./select";
import { apps } from "./apps/apps";
import { requireAuth } from "../../middlewares/requireAuth";

export const workspaces = new Hono();

// Middlewares
workspaces.use(requireAuth);

// Routes (Note: Already requires auth)
workspaces.route("/select", select);
workspaces.route("/:workspaceId/:teamId?", apps);
