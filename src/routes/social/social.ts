import { Hono } from "hono";
import { connections } from "./connections";
import { shortsRoute } from "./shorts";
import { communityGamesRoute } from "./community-games";

export const social = new Hono();

social.route("/connections", connections);
social.route("/shorts", shortsRoute);
social.route("/community-games", communityGamesRoute);
