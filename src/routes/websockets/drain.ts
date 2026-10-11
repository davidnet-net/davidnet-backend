// Aggregates each WS module's own releaseAndDrain() (added alongside their Redis cross-pod work)
// into one call for src/index.ts's shutdown sequence. Each module releases any Redis
// leases/locks it holds for sessions/quizzes it's involved in FIRST, then closes its own local
// socket connections with a reconnect hint - so another pod's watchdog can take over almost
// immediately instead of waiting out a lease's full TTL.
import { releaseAndDrain as drainCommunityRealtime } from "./community_realtime";
import { releaseAndDrain as drainQuizEdit } from "./quiz_edit";
import { releaseAndDrain as drainQuizPlay } from "./quiz_play";
import { releaseAndDrain as drainQuizPresent } from "./quiz_present";

export async function drainAllWebsockets() {
	await Promise.allSettled([
		drainCommunityRealtime(),
		drainQuizEdit(),
		drainQuizPresent(),
		drainQuizPlay()
	]);
}
