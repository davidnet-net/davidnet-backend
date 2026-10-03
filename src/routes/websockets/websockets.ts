import { Hono } from "hono";
import { editWs } from "./quiz_edit";
import { presentWs } from "./quiz_present";
import { playWs } from "./quiz_play";
import { communityRealtimeWs } from "./community_realtime";

export const websockets = new Hono();

websockets.route("/quiz/edit", editWs);
websockets.route("/quiz/present", presentWs);
websockets.route("/quiz/play", playWs);
websockets.route("/community-games", communityRealtimeWs);
