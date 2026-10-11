// src/routes/websockets/quiz_realtime.ts
//
// Shared cross-pod coordination for the live-quiz WebSocket pair (quiz_present.ts = host/
// presenter connections, quiz_play.ts = player connections). This is the hard part of making the
// realtime quiz layer survive running on more than one pod: the question phase-timer
// (preview -> active -> results) is driven by setTimeout chains, and only ONE pod may be driving
// a given session's timer at a time, or two pods racing the same transition would double-broadcast
// conflicting frames to clients.
//
// Design:
// - A Redis lease (`ql:owner:{sessionId}`, SET NX PX, renewed on a short interval) decides which
//   pod currently owns a session's phase-timer. Ownership is NOT pinned to the pod that started
//   the session - any pod with local connections for that session runs a watchdog that attempts to
//   claim ownership the moment the lease is empty (crash/eviction of the previous owner), so the
//   timer chain can resume instead of staying stuck forever.
// - The *content* needed to resume (phase, question index, when the current phase's deadline is,
//   the exact payloads already shown to clients) is mirrored into Redis (`ql:state:{sessionId}`)
//   on every transition, so a new owner can re-arm a timer for the REMAINING time instead of
//   restarting the question from zero.
// - Submitted-answer fidelity for resumption is mirrored into a Redis hash per question
//   (`ql:responses:{sessionId}:{questionIndex}`) rather than relying on Postgres, since
//   `sessionResponses` only stores a single `selectedOptionId` (no `isCorrect`, no multi-select
//   array) - reconstructing from the DB alone would lose information a resumed owner needs.
// - Presenter/player broadcasts never touch sockets directly from business logic. They publish to
//   a per-session Redis channel; every pod (including the publisher) is already subscribed via a
//   single wildcard pattern and relays to whichever of ITS OWN local sockets the message is meant
//   for. This is what makes "a presenter on pod A, players split across pod A and pod B" work
//   correctly - there is exactly one delivery path, used uniformly regardless of which pod a given
//   socket happens to be on.
// - Session-mutating commands (START_SESSION/NEXT_PHASE/STOP_SESSION/SUBMIT_ANSWER) are never
//   handled locally by whichever pod happens to receive the WS message - they're always published
//   to a per-session "command" channel that ONLY the current owner is subscribed to. This removes
//   the need for call sites to branch on "am I the owner" at all.
import { POD_ID, redis, redisSub } from "../../core/shared/redis";

// --- REDIS KEYS / CHANNELS ---
const ownerKey = (sessionId: string) => `ql:owner:${sessionId}`;
const stateKey = (sessionId: string) => `ql:state:${sessionId}`;
const responsesKey = (sessionId: string, questionIndex: number) =>
	`ql:responses:${sessionId}:${questionIndex}`;
const blockedKey = (sessionId: string) => `ql:blocked:${sessionId}`;
const aliveKey = (participantId: string) => `ql:alive:${participantId}`;
const presenceChannel = (sessionId: string) => `ql:presence:${sessionId}`;
const cmdChannel = (sessionId: string) => `ql:cmd:${sessionId}`;
const PRESENCE_PATTERN = "ql:presence:*";

const OWNER_LEASE_MS = 8000;
const OWNER_RENEW_INTERVAL_MS = 2500;
const WATCHDOG_INTERVAL_MS = 3000;
const ALIVE_TTL_MS = 20000;

export type QuizRealtimeState = {
	phase: "preview" | "active" | "results" | "leaderboard" | "finished";
	questionIndex: number;
	quizId: string;
	serverTime: number;
	durationMs: number;
	deadlineAt: number;
	// Precomputed duration for the NEXT auto-advancing phase (preview's stored value is the
	// upcoming "active" phase's time limit), so a resuming owner doesn't need to re-derive it.
	nextDurationMs: number;
	presenterPayload: unknown;
	playerPayload: unknown;
	resultsBreakdown: Record<string, number>;
	leaderboard: unknown[];
};

// --- OWNERSHIP ---
// Compare-and-extend: only renews if this pod still holds the lease - never blindly resurrects a
// lease another pod has since acquired.
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;
// Compare-and-delete, used on graceful release so a stale value from a pod that already lost the
// lease can never delete someone else's active lease.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const GLOBAL_OWNERSHIP_KEY = "__quiz_realtime_ownership__";
if (!(globalThis as any)[GLOBAL_OWNERSHIP_KEY]) {
	(globalThis as any)[GLOBAL_OWNERSHIP_KEY] = {
		ownedSessions: new Set<string>(),
		renewTimers: new Map<string, ReturnType<typeof setInterval>>(),
		localPhaseTimers: new Map<string, ReturnType<typeof setTimeout>>()
	};
}
const ownershipState = (globalThis as any)[GLOBAL_OWNERSHIP_KEY];
const ownedSessions: Set<string> = ownershipState.ownedSessions;
const renewTimers: Map<string, ReturnType<typeof setInterval>> = ownershipState.renewTimers;
// Local setTimeout handle for the phase-auto-advance chain, per sessionId - cleared whenever this
// pod loses ownership (zombie prevention) or the session terminates.
const localPhaseTimers: Map<
	string,
	ReturnType<typeof setTimeout>
> = ownershipState.localPhaseTimers;

export function isOwnedLocally(sessionId: string): boolean {
	return ownedSessions.has(sessionId);
}

function clearLocalPhaseTimer(sessionId: string) {
	const timer = localPhaseTimers.get(sessionId);
	if (timer) clearTimeout(timer);
	localPhaseTimers.delete(sessionId);
}

async function stopOwning(sessionId: string) {
	ownedSessions.delete(sessionId);
	const renewTimer = renewTimers.get(sessionId);
	if (renewTimer) clearInterval(renewTimer);
	renewTimers.delete(sessionId);
	clearLocalPhaseTimer(sessionId);
	await redisSub.unsubscribe(cmdChannel(sessionId)).catch(() => {});
}

// Attempts to become (or stay) the owner of `sessionId`. Safe to call unconditionally and often -
// a pod that already owns the session just no-ops (its renew interval handles staying current),
// and a pod that doesn't is making exactly the cheap SET NX attempt the watchdog needs.
export async function claimOwnership(sessionId: string): Promise<boolean> {
	if (ownedSessions.has(sessionId)) return true;

	const result = await redis.set(ownerKey(sessionId), POD_ID, "PX", OWNER_LEASE_MS, "NX");
	if (result !== "OK") return false;

	ownedSessions.add(sessionId);
	await redisSub.subscribe(cmdChannel(sessionId));

	const renewTimer = setInterval(async () => {
		const stillOwner = await redis.eval(
			RENEW_SCRIPT,
			1,
			ownerKey(sessionId),
			POD_ID,
			String(OWNER_LEASE_MS)
		);
		if (stillOwner === 0) {
			await stopOwning(sessionId);
		}
	}, OWNER_RENEW_INTERVAL_MS);
	renewTimers.set(sessionId, renewTimer);

	return true;
}

// Best-effort re-verification before taking any observable action (writing state, broadcasting).
// A pod whose lease silently expired (GC pause, transient Redis blip) but whose local timer still
// fired must detect "I'm not the owner anymore" and abort rather than double-broadcast against
// whichever pod has since taken over. This is a plain read-then-act check, not a single atomic
// operation spanning the Postgres calls callers make in between - the race window it leaves open
// is small (one Redis round trip) and accepted as a residual risk alongside the others documented
// in the planning doc, not something this function alone can close.
export async function isStillOwner(sessionId: string): Promise<boolean> {
	if (!ownedSessions.has(sessionId)) return false;
	const current = await redis.get(ownerKey(sessionId));
	return current === POD_ID;
}

// Called on graceful shutdown (src/index.ts's drain sequence) so another pod's watchdog can take
// over within one watchdog tick instead of waiting out the full lease TTL.
export async function releaseOwnership(sessionId: string) {
	if (!ownedSessions.has(sessionId)) return;
	await redis.eval(RELEASE_SCRIPT, 1, ownerKey(sessionId), POD_ID);
	await stopOwning(sessionId);
}

export function allOwnedSessionIds(): string[] {
	return Array.from(ownedSessions);
}

// --- WATCHDOG ---
// Each of quiz_present.ts/quiz_play.ts registers a callback returning the sessionIds it currently
// has local connections for - the watchdog's "sessions worth claiming" set is the union of both,
// so either a presenter-only or a player-only pod can take over a session whose previous owner
// died, not just whichever pod happens to hold the host connection.
const interestSources: Array<() => Iterable<string>> = [];
export function registerInterestSource(source: () => Iterable<string>) {
	interestSources.push(source);
}

const GLOBAL_WATCHDOG_KEY = "__quiz_realtime_watchdog__";
if ((globalThis as any)[GLOBAL_WATCHDOG_KEY]) {
	clearInterval((globalThis as any)[GLOBAL_WATCHDOG_KEY]);
}
(globalThis as any)[GLOBAL_WATCHDOG_KEY] = setInterval(() => {
	const candidates = new Set<string>();
	for (const source of interestSources) {
		for (const sessionId of source()) candidates.add(sessionId);
	}
	for (const sessionId of candidates) {
		if (!ownedSessions.has(sessionId)) void claimOwnership(sessionId);
	}
}, WATCHDOG_INTERVAL_MS);

// --- RESUMABLE PHASE STATE ---
export async function getState(sessionId: string): Promise<QuizRealtimeState | null> {
	const raw = await redis.get(stateKey(sessionId));
	return raw ? JSON.parse(raw) : null;
}

export async function setState(sessionId: string, state: QuizRealtimeState) {
	// 6h TTL as a safety net against leaked state for abandoned sessions - routine
	// STOP_SESSION/FINISHED cleanup deletes it explicitly well before that.
	await redis.set(stateKey(sessionId), JSON.stringify(state), "EX", 6 * 60 * 60);
}

export async function deleteState(sessionId: string) {
	await redis.del(stateKey(sessionId));
}

// --- RESPONSES (per question, for takeover fidelity) ---
export async function recordResponse(
	sessionId: string,
	questionIndex: number,
	participantId: string,
	value: { isCorrect: boolean; pointsEarned: number; selectedOptionIds: string[] }
) {
	const key = responsesKey(sessionId, questionIndex);
	await redis.hset(key, participantId, JSON.stringify(value));
	await redis.expire(key, 6 * 60 * 60); // safety net, same window as setState's TTL
}

export async function getResponses(
	sessionId: string,
	questionIndex: number
): Promise<Map<string, { isCorrect: boolean; pointsEarned: number; selectedOptionIds: string[] }>> {
	const raw = await redis.hgetall(responsesKey(sessionId, questionIndex));
	const map = new Map<string, any>();
	for (const [participantId, json] of Object.entries(raw)) map.set(participantId, JSON.parse(json));
	return map;
}

export async function hasResponded(
	sessionId: string,
	questionIndex: number,
	participantId: string
) {
	return (await redis.hexists(responsesKey(sessionId, questionIndex), participantId)) === 1;
}

export async function countResponses(sessionId: string, questionIndex: number) {
	return redis.hlen(responsesKey(sessionId, questionIndex));
}

// --- CONNECTED PARTICIPANTS (cross-pod count, for "did everyone answer" auto-advance) ---
// The original single-process code counted connected players by scanning the local
// wsByParticipant map - already pod-local-only once more than one pod exists. This Set is
// authoritative across every pod: added on a successful JOIN_NICKNAME (any pod), removed on
// terminateParticipant (any pod, including the heartbeat's own dead-connection cleanup).
const connectedKey = (sessionId: string) => `ql:connected:${sessionId}`;

export async function addConnectedParticipant(sessionId: string, participantId: string) {
	await redis.sadd(connectedKey(sessionId), participantId);
}

export async function removeConnectedParticipant(sessionId: string, participantId: string) {
	await redis.srem(connectedKey(sessionId), participantId);
}

export async function countConnectedParticipants(sessionId: string): Promise<number> {
	return redis.scard(connectedKey(sessionId));
}

export async function listConnectedParticipants(sessionId: string): Promise<string[]> {
	return redis.smembers(connectedKey(sessionId));
}

export async function deleteConnectedParticipants(sessionId: string) {
	await redis.del(connectedKey(sessionId));
}

// --- BLOCKED NICKNAMES ---
export async function blockNickname(sessionId: string, nickname: string) {
	await redis.sadd(blockedKey(sessionId), nickname.toLowerCase());
}

export async function isNicknameBlocked(sessionId: string, nickname: string): Promise<boolean> {
	return (await redis.sismember(blockedKey(sessionId), nickname.toLowerCase())) === 1;
}

// --- PARTICIPANT LIVENESS (cross-pod reconnect fix) ---
// A participant can reconnect on a different pod than the one that started its disconnect-grace
// timer. That pod's local wsByParticipant lookup would otherwise see no entry and wrongly
// terminate a still-alive participant; checking this key too (refreshed by whichever pod
// currently holds the connection) closes that gap.
export async function markParticipantAlive(participantId: string) {
	await redis.set(aliveKey(participantId), POD_ID, "PX", ALIVE_TTL_MS);
}

export async function isParticipantAliveSomewhere(participantId: string): Promise<boolean> {
	return (await redis.exists(aliveKey(participantId))) === 1;
}

export async function clearParticipantAlive(participantId: string) {
	await redis.del(aliveKey(participantId));
}

// Same reconnect-on-a-different-pod problem, for the presenter/host side: if the host's local
// presenter-heartbeat grace timer on pod A fires while the host has since reconnected on pod B,
// pod A must not terminate the session out from under a host that's actually still there.
const presenterAliveKey = (sessionId: string) => `ql:presenter-alive:${sessionId}`;
const PRESENTER_ALIVE_TTL_MS = 20000;

export async function markPresenterAlive(sessionId: string) {
	await redis.set(presenterAliveKey(sessionId), POD_ID, "PX", PRESENTER_ALIVE_TTL_MS);
}

export async function isPresenterAliveSomewhere(sessionId: string): Promise<boolean> {
	return (await redis.exists(presenterAliveKey(sessionId))) === 1;
}

export async function clearPresenterAlive(sessionId: string) {
	await redis.del(presenterAliveKey(sessionId));
}

// --- PRESENCE / BROADCAST (publish-only; delivery happens in each file's own subscriber) ---
type PresenceEnvelope =
	| { target: "presenters"; sessionId: string; frame: unknown }
	| { target: "players"; sessionId: string; frame: unknown }
	| { target: "players-scatter"; sessionId: string; payloads: Record<string, unknown> }
	| {
			target: "player";
			sessionId: string;
			participantId: string;
			frame: unknown;
			close?: { code: number; reason: string };
	  };

export function publishToPresenters(sessionId: string, frame: unknown) {
	void redis.publish(
		presenceChannel(sessionId),
		JSON.stringify({ target: "presenters", sessionId, frame })
	);
}

export function publishToPlayers(sessionId: string, frame: unknown) {
	void redis.publish(
		presenceChannel(sessionId),
		JSON.stringify({ target: "players", sessionId, frame })
	);
}

export function publishScatterToPlayers(sessionId: string, payloads: Record<string, unknown>) {
	void redis.publish(
		presenceChannel(sessionId),
		JSON.stringify({ target: "players-scatter", sessionId, payloads })
	);
}

export function publishToPlayer(
	sessionId: string,
	participantId: string,
	frame: unknown,
	close?: { code: number; reason: string }
) {
	void redis.publish(
		presenceChannel(sessionId),
		JSON.stringify({ target: "player", sessionId, participantId, frame, close })
	);
}

const presenterFrameHandlers: Array<(sessionId: string, frame: unknown) => void> = [];
const playerFrameHandlers: Array<(sessionId: string, frame: unknown) => void> = [];
const playerScatterHandlers: Array<(sessionId: string, payloads: Record<string, unknown>) => void> =
	[];
const playerTargetedHandlers: Array<
	(
		sessionId: string,
		participantId: string,
		frame: unknown,
		close?: { code: number; reason: string }
	) => void
> = [];

export function onPresenterFrame(handler: (sessionId: string, frame: unknown) => void) {
	presenterFrameHandlers.push(handler);
}
export function onPlayerFrame(handler: (sessionId: string, frame: unknown) => void) {
	playerFrameHandlers.push(handler);
}
export function onPlayerScatter(
	handler: (sessionId: string, payloads: Record<string, unknown>) => void
) {
	playerScatterHandlers.push(handler);
}
export function onPlayerTargeted(
	handler: (
		sessionId: string,
		participantId: string,
		frame: unknown,
		close?: { code: number; reason: string }
	) => void
) {
	playerTargetedHandlers.push(handler);
}

const GLOBAL_PRESENCE_SUB_KEY = "__quiz_realtime_presence_sub__";
if (!(globalThis as any)[GLOBAL_PRESENCE_SUB_KEY]) {
	redisSub.psubscribe(PRESENCE_PATTERN).catch((err) => {
		console.error("[QuizRealtime]: Failed to subscribe to presence pattern:", err);
	});
	redisSub.on("pmessage", (pattern: string, _channel: string, message: string) => {
		if (pattern !== PRESENCE_PATTERN) return;
		let envelope: PresenceEnvelope;
		try {
			envelope = JSON.parse(message);
		} catch {
			return;
		}

		if (envelope.target === "presenters") {
			for (const handler of presenterFrameHandlers) handler(envelope.sessionId, envelope.frame);
		} else if (envelope.target === "players") {
			for (const handler of playerFrameHandlers) handler(envelope.sessionId, envelope.frame);
		} else if (envelope.target === "players-scatter") {
			for (const handler of playerScatterHandlers) handler(envelope.sessionId, envelope.payloads);
		} else if (envelope.target === "player") {
			for (const handler of playerTargetedHandlers)
				handler(envelope.sessionId, envelope.participantId, envelope.frame, envelope.close);
		}
	});
	(globalThis as any)[GLOBAL_PRESENCE_SUB_KEY] = true;
}

// --- OWNER-ONLY COMMANDS ---
// Only the current owner is subscribed to ql:cmd:{sessionId} (subscribed on claimOwnership,
// unsubscribed on stopOwning) - callers never need to branch on "am I the owner", they just send
// the command and whichever pod is subscribed handles it. A command published in the narrow
// window where a session has no owner yet (just after a crash, before the watchdog's next tick
// claims it) has no subscriber and is dropped - an accepted, documented edge case, not a lossless
// delivery guarantee.
type CmdKind = "host" | "answer";
const cmdHandlers = new Map<CmdKind, (sessionId: string, payload: any) => void>();

export function onCmd(kind: CmdKind, handler: (sessionId: string, payload: any) => void) {
	cmdHandlers.set(kind, handler);
}

export function sendOwnerCommand(sessionId: string, kind: CmdKind, payload: unknown) {
	void redis.publish(cmdChannel(sessionId), JSON.stringify({ kind, payload }));
}

const GLOBAL_CMD_SUB_KEY = "__quiz_realtime_cmd_sub__";
if (!(globalThis as any)[GLOBAL_CMD_SUB_KEY]) {
	redisSub.on("message", (channel: string, message: string) => {
		if (!channel.startsWith("ql:cmd:")) return;
		const sessionId = channel.slice("ql:cmd:".length);
		if (!ownedSessions.has(sessionId)) return; // not subscribed unless owner, but defensive anyway

		let parsed: { kind: CmdKind; payload: unknown };
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		const handler = cmdHandlers.get(parsed.kind);
		if (handler) handler(sessionId, parsed.payload);
	});
	(globalThis as any)[GLOBAL_CMD_SUB_KEY] = true;
}

// --- RESUMABLE TIMER ARMING ---
// Re-arms (or arms for the first time) the local setTimeout that will auto-advance a session's
// phase, based entirely on what's in Redis - this is what lets a NEWLY-owning pod resume a
// question's countdown at the correct remaining time after taking over from a dead pod, instead
// of restarting it from zero. Only "preview" and "active" auto-advance; "results"/"leaderboard"
// wait for an explicit host NEXT_PHASE command, and "finished"/"lobby" have no timer at all.
export async function armPhaseTimer(
	sessionId: string,
	onAdvance: (sessionId: string, fromPhase: "preview" | "active") => Promise<void>
) {
	clearLocalPhaseTimer(sessionId);

	const state = await getState(sessionId);
	if (!state) return;
	if (state.phase !== "preview" && state.phase !== "active") return;

	const remaining = Math.max(0, state.deadlineAt - Date.now());
	const timer = setTimeout(
		() => void onAdvance(sessionId, state.phase as "preview" | "active"),
		remaining
	);
	localPhaseTimers.set(sessionId, timer);
}

export function clearPhaseTimer(sessionId: string) {
	clearLocalPhaseTimer(sessionId);
}
