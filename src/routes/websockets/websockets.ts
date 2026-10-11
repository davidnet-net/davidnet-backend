import { Hono } from "hono";

import { communityRealtimeWs } from "./community_realtime";
import { editWs } from "./quiz_edit";
import { playWs } from "./quiz_play";
import { presentWs } from "./quiz_present";

export const websockets = new Hono();

websockets.route("/quiz/edit", editWs);
websockets.route("/quiz/present", presentWs);
websockets.route("/quiz/play", playWs);
websockets.route("/community-games", communityRealtimeWs);
