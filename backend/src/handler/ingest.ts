import { Router, Request, Response } from 'express';
import { Server as SocketServer } from 'socket.io';
import { MatchRecorder } from './matchRecorder';
import { MetricsCollector } from './metrics';

// ─── Per-Server State Cache ──────────────────────────────────────────────────
// Tracks the latest game state per server so late-joining frontends get a
// snapshot on connect. State is keyed by server hostname (X-Server-Hostname).

interface ServerState {
    players: Map<string, any>;    // user_id → latest player_connect/spawn/score state
    team_score: any | null;       // latest team_score event
    flags: any | null;            // latest flags_init event
    timeleft: any | null;         // latest time_sync event
}

const serverStates = new Map<string, ServerState>();

function getOrCreateState(server: string): ServerState {
    if (!serverStates.has(server)) {
        serverStates.set(server, {
            players: new Map(),
            team_score: null,
            flags: null,
            timeleft: null,
        });
    }
    return serverStates.get(server)!;
}

function updateServerState(server: string, event: any): void {
    const state = getOrCreateState(server);

    switch (event.event) {
        case 'player_connect':
            state.players.set(event.user_id, {
                ...state.players.get(event.user_id),
                user_id: event.user_id,
                name: event.name,
                team: event.team,
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
                alive: true,
            });
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
            }
            break;
        case 'kill':
            if (state.players.has(event.victim_id)) {
                state.players.get(event.victim_id).alive = false;
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
        case 'half_start':
            // Reset player stats on half start
            state.players.forEach(p => {
                p.kills = 0; p.deaths = 0; p.score = 0;
                p.alive = true; p.class_id = null;
            });
            state.team_score = null;
            state.timeleft = event;
            break;
    }
}

/**
 * Returns the cached state snapshot for a server, formatted as an array
 * of events that can be replayed by the frontend.
 */
export function getServerSnapshot(server: string): string[] {
    const state = serverStates.get(server);
    if (!state) return [];

    const events: string[] = [];

    // Replay flags first
    if (state.flags) events.push(JSON.stringify(state.flags));

    // Replay team score
    if (state.team_score) events.push(JSON.stringify(state.team_score));

    // Replay timeleft
    if (state.timeleft) events.push(JSON.stringify(state.timeleft));

    // Replay players: emit player_connect then player_spawn for each
    state.players.forEach((p) => {
        if (p.team === 'spectator' || p.team === 'unassigned') return;
        events.push(JSON.stringify({
            event: 'player_connect', user_id: p.user_id, name: p.name, team: p.team,
        }));
        if (p.class_id != null) {
            events.push(JSON.stringify({
                event: 'player_spawn', user_id: p.user_id, name: p.name, team: p.team,
                class_id: p.class_id, weapon_primary: p.weapon_primary, weapon_secondary: p.weapon_secondary,
            }));
        }
        if (p.kills != null || p.deaths != null) {
            events.push(JSON.stringify({
                event: 'player_score', user_id: p.user_id,
                kills: p.kills ?? 0, deaths: p.deaths ?? 0, score: p.score ?? 0,
            }));
        }
    });

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
export function createIngestRouter(
    authKey: string,
    recorder: MatchRecorder,
    io: SocketServer,
    metrics: MetricsCollector,
): Router {
    const router = Router();

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

        // Handle match lifecycle events
        if (event.event === 'ktp_match_start' && matchId) {
            recorder.startMatch(
                matchId,
                event.map ?? 'unknown',
                event.match_type ?? 0,
                event.half ?? 0,
                sourceServer,
            );
        }

        // Update per-server state cache (for late-joining frontends)
        updateServerState(sourceServer, event);

        // Only record events that belong to a real match (started via ktp_match_start).
        // Pre-match warmup / casual events are still emitted to server-room observers
        // for live HUD use, but don't create a phantom "unknown" match record.
        if (matchId) {
            recorder.recordEvent(matchId, event, sourceServer);
            io.to(matchId).emit(event.event, JSON.stringify(event));
        }

        // Emit to server-based room (observers connected before match starts)
        io.to(`server:${sourceServer}`).emit(event.event, JSON.stringify(event));

        // Also emit to a global "all" room for dashboards monitoring all matches
        io.to('all').emit(event.event, JSON.stringify(event));

        // Legacy: also emit to 'hud_socket' room for frontends without ?match= param
        io.to('hud_socket').emit(event.event, JSON.stringify(event));

        // Handle match end
        if (event.event === 'ktp_match_end' && matchId) {
            recorder.endMatch(matchId);
        }

        // Track metrics
        metrics.recordEvent(sourceServer);

        // Plugin-side latency measurement: if the plugin sends X-Plugin-Sent-At
        // (unix ms), calculate end-to-end latency
        const sentAt = req.headers['x-plugin-sent-at'];
        if (sentAt) {
            const latency = Date.now() - parseInt(sentAt as string, 10);
            metrics.recordLatency(sourceServer, latency);
        }

        res.status(200).json({ ok: true });
    });

    return router;
}
