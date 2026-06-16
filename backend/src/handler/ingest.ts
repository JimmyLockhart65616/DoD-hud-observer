import { Router, Request, Response } from 'express';
import { Server as SocketServer } from 'socket.io';
import { MatchRecorder } from './matchRecorder';
import { MetricsCollector } from './metrics';
import { HltvDelayBuffer } from './hltvDelayBuffer';
import { HltvSyncService } from './hltvSync';

// ─── Per-Server State Cache ──────────────────────────────────────────────────
// Tracks the latest game state per server so late-joining frontends get a
// snapshot on connect. State is keyed by server hostname (X-Server-Hostname).

// Evict cached players whose lastSeen is older than this from snapshot replay.
// Covers missed player_disconnect events (crashes, changelevel, rcon restart).
// During live play every player gets refreshed by spawn/score/kill/prone/etc.,
// so only genuine ghosts age out. 5 min is generous enough for pre-match
// lobbies where players can sit idle without emitting per-player events.
const PLAYER_STALE_MS = 5 * 60 * 1000;

// Socket-only events: live overlay state that must NOT be persisted to
// events.jsonl. player_state is the 4 Hz per-player snapshot (every alive
// player, every tick); weapon_active fires on every weapon switch. Both carry
// transient state with near-zero replay value, and writing them would bloat the
// match log and hammer MatchRecorder's synchronous appendFileSync hot path.
// They still fan out to sockets + metrics — just skipped on disk.
const SOCKET_ONLY_EVENTS = new Set(['player_state', 'weapon_active']);

// Per-player stat fields introduced by the stats-popup feature. Shared by the
// player_score copy, the half_start reset, and the snapshot replay so the
// three can never drift apart.
const PLAYER_STAT_FIELDS = [
    'damage', 'assists', 'hs_kills', 'nade_kills', 'gun_kills', 'hits', 'hs_hits',
    'caps', 'best_streak',
] as const;

interface ServerState {
    players: Map<string, any>;    // user_id → latest player_connect/spawn/score state
    team_score: any | null;       // latest team_score event
    flags: any | null;            // latest flags_init event
    timeleft: any | null;         // latest time_sync event
    half: number | null;          // current half (1, 2, 101+) from latest half_start
    round_phase: 'freeze' | 'live' | 'end' | null;  // latest round_start_freeze/round_start/round_end
    halftime_summary: any | null; // latest player_stats_summary with reason half_end —
                                  // replayed to late joiners so a freshly-loaded OBS
                                  // page at halftime still auto-shows the stats board
}

const serverStates = new Map<string, ServerState>();

function getOrCreateState(server: string): ServerState {
    if (!serverStates.has(server)) {
        serverStates.set(server, {
            players: new Map(),
            team_score: null,
            flags: null,
            timeleft: null,
            half: null,
            round_phase: null,
            halftime_summary: null,
        });
    }
    return serverStates.get(server)!;
}

function updateServerState(server: string, event: any): void {
    const state = getOrCreateState(server);
    const now = Date.now();

    switch (event.event) {
        case 'ktp_match_start':
        case 'ktp_match_end':
            // Hard reset between matches — any stale ghosts from the previous
            // session can't survive a new match boundary.
            state.players.clear();
            state.team_score = null;
            state.round_phase = null;
            state.halftime_summary = null;
            if (event.event === 'ktp_match_start' && event.half != null) {
                state.half = event.half;
            }
            break;
        case 'player_connect':
            state.players.set(event.user_id, {
                ...state.players.get(event.user_id),
                user_id: event.user_id,
                name: event.name,
                team: event.team,
                lastSeen: now,
            });
            break;
        case 'player_spawn':
            state.players.set(event.user_id, {
                ...state.players.get(event.user_id),
                user_id: event.user_id,
                name: event.name ?? state.players.get(event.user_id)?.name ?? event.user_id,
                team: event.team,
                class_id: event.class_id,
                weapon_primary: event.weapon_primary,
                weapon_secondary: event.weapon_secondary,
                health: event.health ?? 100,
                alive: true,
                lastSeen: now,
            });
            break;
        case 'roster_player':
            // Snapshot row from the plugin's match-start roster dump. Carries
            // alive/dead, class, weapons, and current health for every connected
            // player. The frontend uses this to seed the HUD without lying about
            // a "spawn" for a currently-dead player.
            state.players.set(event.user_id, {
                ...state.players.get(event.user_id),
                user_id: event.user_id,
                name: event.name ?? state.players.get(event.user_id)?.name ?? event.user_id,
                team: event.team,
                class_id: event.alive ? event.class_id : null,
                weapon_primary: event.alive ? event.weapon_primary : null,
                weapon_secondary: event.alive ? event.weapon_secondary : null,
                health: event.health ?? (event.alive ? 100 : 0),
                alive: !!event.alive,
                lastSeen: now,
            });
            break;
        case 'damage':
            if (state.players.has(event.victim_id)) {
                state.players.get(event.victim_id).health = Math.max(0, event.victim_health ?? 0);
            }
            break;
        case 'prone_change':
            if (state.players.has(event.user_id)) {
                const p = state.players.get(event.user_id);
                p.prone_state = event.state;
                p.prone_since = event.state !== 'standing' ? event.timestamp : null;
            }
            break;
        case 'player_team_change':
            if (state.players.has(event.user_id)) {
                state.players.get(event.user_id).team = event.team;
            }
            break;
        case 'player_score':
            if (state.players.has(event.user_id)) {
                const p = state.players.get(event.user_id);
                p.kills = event.kills;
                p.deaths = event.deaths;
                p.score = event.score;
                p.obj_score = event.obj_score ?? 0;
                // Stat fields absent from old-plugin events default to 0.
                PLAYER_STAT_FIELDS.forEach(f => { p[f] = event[f] ?? 0; });
            }
            break;
        case 'player_stats_summary':
            // Batched per-player stats from the plugin — merge each row into
            // the cache by user_id (rows are authoritative for stat fields).
            (event.players ?? []).forEach((row: any) => {
                if (!state.players.has(row.user_id)) return;
                const p = state.players.get(row.user_id);
                p.kills = row.kills ?? p.kills;
                p.deaths = row.deaths ?? p.deaths;
                p.obj_score = row.obj_score ?? p.obj_score;
                PLAYER_STAT_FIELDS.forEach(f => { p[f] = row[f] ?? 0; });
                p.lastSeen = now;
            });
            if (event.reason === 'half_end') {
                state.halftime_summary = event;
            }
            break;
        case 'kill':
            if (state.players.has(event.victim_id)) {
                const v = state.players.get(event.victim_id);
                v.alive = false;
                v.health = 0;
                v.prone_state = 'standing';
                v.prone_since = null;
            }
            break;
        case 'player_disconnect':
            state.players.delete(event.user_id);
            break;
        case 'team_score':
            state.team_score = event;
            break;
        case 'flags_init':
            state.flags = event;
            break;
        case 'flag_captured':
            // Update flag owner in cached flags_init
            if (state.flags?.flags) {
                const flag = state.flags.flags.find((f: any) => f.flag_id === event.flag_id);
                if (flag) flag.owner = event.new_owner;
            }
            break;
        case 'time_sync':
            state.timeleft = event;
            break;
        case 'round_start_freeze':
            state.round_phase = 'freeze';
            break;
        case 'round_start':
            state.round_phase = 'live';
            break;
        case 'round_end':
            state.round_phase = 'end';
            break;
        case 'half_start':
            // Per-player stat reset, but keep the cached team_score: until the
            // plugin's post-half_start team_score event arrives, the half-1
            // total is still the correct thing to show a late-joining client.
            state.players.forEach(p => {
                p.kills = 0; p.deaths = 0; p.score = 0; p.obj_score = 0;
                p.alive = true; p.class_id = null; p.health = 100;
                p.prone_state = 'standing'; p.prone_since = null;
                PLAYER_STAT_FIELDS.forEach(f => { p[f] = 0; });
                p.lastSeen = now;
            });
            if (event.half != null) state.half = event.half;
            state.round_phase = null;
            state.timeleft = event;
            // Evict the cached halftime board so it can't replay over live play.
            // Normally ktp_match_start (fired just before half_start) already
            // cleared it, but a dropped ktp_match_start POST — or a half_start-
            // only boundary — would otherwise strand the prior half's board.
            state.halftime_summary = null;
            break;
    }

    // Refresh lastSeen for any event referencing an already-cached player.
    // Catches prone_change, weapon_pickup, nade_throw, user_say, etc. without
    // a per-event case — any sign of life keeps the player out of the stale bin.
    const uid = event.user_id ?? event.killer_id;
    if (uid && state.players.has(uid)) {
        state.players.get(uid).lastSeen = now;
    }
}

/**
 * Returns the number of human players currently on Allies or Axis for a given
 * server. Applies the same PLAYER_STALE_MS filter used by getServerSnapshot so
 * ghost players from missed disconnects don't inflate the count. HLTV bots sit
 * on `spectator` / `unassigned` and are naturally excluded.
 */
export function getServerPlayerCount(server: string): number {
    const state = serverStates.get(server);
    if (!state) return 0;
    const now = Date.now();
    let count = 0;
    state.players.forEach((p) => {
        if (p.team !== 'allies' && p.team !== 'axis') return;
        if (now - (p.lastSeen ?? 0) > PLAYER_STALE_MS) return;
        count++;
    });
    return count;
}

/**
 * Returns the cached state snapshot for a server, formatted as an array
 * of events that can be replayed by the frontend.
 */
export function getServerSnapshot(server: string): string[] {
    const state = serverStates.get(server);
    if (!state) return [];

    const events: string[] = [];

    // Replay half number first so the HUD's top-of-screen renders the right half.
    if (state.half != null) {
        events.push(JSON.stringify({ event: 'half_start', half: state.half }));
    }

    // Replay flags
    if (state.flags) events.push(JSON.stringify(state.flags));

    // Replay team score
    if (state.team_score) events.push(JSON.stringify(state.team_score));

    // Replay timeleft
    if (state.timeleft) events.push(JSON.stringify(state.timeleft));

    // Replay round phase so a late joiner knows whether a round is live/freeze/end.
    if (state.round_phase === 'freeze') {
        events.push(JSON.stringify({ event: 'round_start_freeze' }));
    } else if (state.round_phase === 'live') {
        const tl = state.timeleft?.timeleft;
        events.push(JSON.stringify({ event: 'round_start', ...(tl != null ? { timeleft: tl } : {}) }));
    }
    // 'end' is intentionally omitted — replaying it would trigger the frontend's
    // 5s revive timer for an already-completed round; harmless but visually odd.

    // Replay players: emit roster_player (state-of-the-world) for each.
    const now = Date.now();
    state.players.forEach((p) => {
        if (p.team === 'spectator' || p.team === 'unassigned') return;
        // Drop stale entries — missed disconnects age out here
        if (now - (p.lastSeen ?? 0) > PLAYER_STALE_MS) return;
        events.push(JSON.stringify({
            event: 'player_connect', user_id: p.user_id, name: p.name, team: p.team,
        }));
        // Use roster_player for the snapshot row — it carries health/alive/prone
        // and doesn't lie about a fresh spawn for a currently-dead player.
        events.push(JSON.stringify({
            event: 'roster_player',
            user_id: p.user_id, name: p.name, team: p.team,
            alive: p.alive ?? (p.class_id != null),
            class_id: p.class_id ?? -1,
            weapon_primary: p.weapon_primary ?? 'none',
            weapon_secondary: p.weapon_secondary ?? 'none',
            health: p.health ?? (p.alive === false ? 0 : 100),
            prone_state: p.prone_state ?? 'standing',
            prone_since: p.prone_since ?? null,
        }));
        if (p.kills != null || p.deaths != null) {
            const score: any = {
                event: 'player_score', user_id: p.user_id,
                kills: p.kills ?? 0, deaths: p.deaths ?? 0,
                score: p.score ?? 0, obj_score: p.obj_score ?? 0,
            };
            PLAYER_STAT_FIELDS.forEach(f => { score[f] = p[f] ?? 0; });
            events.push(JSON.stringify(score));
        }
    });

    // Replay the halftime stats summary last so a freshly-loaded OBS page at
    // halftime auto-shows the stats board (players are already seeded above).
    if (state.halftime_summary) {
        events.push(JSON.stringify(state.halftime_summary));
    }

    return events;
}

/**
 * Creates the /ingest POST route.
 *
 * The AMXX plugin (via KTPAMXXCurl) POSTs one JSON event per request:
 *   POST /ingest
 *   X-Auth-Key: <secret>
 *   Content-Type: application/json
 *   { "event": "kill", "match_id": "KTP-...", ... }
 *
 * The route:
 *   1. Validates X-Auth-Key
 *   2. Records the event via MatchRecorder
 *   3. Emits to the Socket.IO room for that matchId
 *   4. Returns 200 OK
 */
/**
 * The deferred fire path: applied to each event after the HLTV delay window.
 * Updates the per-server state cache (so late-joiner snapshots reflect what
 * HLTV is currently broadcasting, not real-time state) and emits to all
 * socket rooms. Exported so app.ts can wire it as the buffer's onFire
 * callback exactly once at startup, rather than per ingest router.
 */
export function makeFireToSockets(io: SocketServer) {
    return (server: string, matchId: string | undefined, event: any) => {
        updateServerState(server, event);
        if (matchId) io.to(matchId).emit(event.event, JSON.stringify(event));
        io.to(`server:${server}`).emit(event.event, JSON.stringify(event));
        io.to('all').emit(event.event, JSON.stringify(event));
        io.to('hud_socket').emit(event.event, JSON.stringify(event));
    };
}

export function createIngestRouter(
    authKey: string,
    recorder: MatchRecorder,
    io: SocketServer,
    metrics: MetricsCollector,
    delayBuffer?: HltvDelayBuffer,
    hltvSync?: HltvSyncService,
): Router {
    const router = Router();
    const fireToSockets = makeFireToSockets(io);

    router.post('/', (req: Request, res: Response) => {
        // Auth check
        const key = req.headers['x-auth-key'];
        if (key !== authKey) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        const event = req.body;
        if (!event || !event.event) {
            res.status(400).json({ error: 'missing event field' });
            return;
        }

        const matchId: string | undefined = event.match_id;
        const sourceServer = (req.headers['x-server-hostname'] as string)
            ?? req.socket.remoteAddress
            ?? 'unknown';

        // ─── IMMEDIATE phase ───────────────────────────────────────────────
        // Disk write (ground truth), metrics, match-lifecycle bookkeeping.
        // Runs synchronously regardless of HLTV-sync state — replays read
        // from events.jsonl and must see real-time-ordered events.

        if (event.event === 'ktp_match_start' && matchId) {
            recorder.startMatch(
                matchId,
                event.map ?? 'unknown',
                event.match_type ?? 0,
                event.half ?? 0,
                sourceServer,
            );
            // Force a fresh HLTV sample at match start so the buffer has an
            // accurate clock for the upcoming match's events.
            if (hltvSync?.isActive(sourceServer)) {
                void hltvSync.sample(sourceServer, 'ktp_match_start');
            }
        }

        if (matchId && !SOCKET_ONLY_EVENTS.has(event.event)) {
            recorder.recordEvent(matchId, event, sourceServer);
        }

        if (event.event === 'ktp_match_end' && matchId) {
            recorder.endMatch(matchId);
        }

        metrics.recordEvent(sourceServer);

        const sentAt = req.headers['x-plugin-sent-at'];
        if (sentAt) {
            const latency = Date.now() - parseInt(sentAt as string, 10);
            metrics.recordLatency(sourceServer, latency);
        }

        // ─── Lazy init / map-change detection ──────────────────────────────
        // Triggers a sample on first event from a server, and on detected
        // map change (event.map differs from cached map). No-op when the
        // server isn't configured for HLTV sync.
        hltvSync?.onIngestEvent(sourceServer, event);

        // ─── DEFERRED phase ────────────────────────────────────────────────
        // If HLTV sync is active for this server, enqueue for later release;
        // otherwise emit immediately (back-compat for unconfigured servers
        // and for the feature flag being off).

        if (delayBuffer?.isActive(sourceServer)) {
            delayBuffer.enqueue({ server: sourceServer, matchId, event, enqueuedAt: Date.now() });
        } else {
            fireToSockets(sourceServer, matchId, event);
        }

        res.status(200).json({ ok: true });
    });

    return router;
}
