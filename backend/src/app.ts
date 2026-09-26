import express from 'express';
import path from 'path';
import cors from 'cors';
import config from './config';
import * as statsDb from './statsdb/statsDb';
import { StatsGuard } from './statsdb/guard';
import { MAX_CAREER_BATCH } from './statsdb/queries';
import { MatchRecorder } from './handler/matchRecorder';
import { MetricsCollector } from './handler/metrics';
import { createIngestRouter, getServerPlayerCount, makeFireToSockets } from './handler/ingest';
import { pseudonymize, resolvePlayerId, rekeyByToken } from './handler/pseudonym';
import { buildHqOverview } from './handler/hqBoard';
import { buildServerList } from './handler/serverList';
import { createSocketServer } from './socket/socket';
import { HltvSyncService } from './handler/hltvSync';
import { HltvDelayBuffer, wireStrandedRescue } from './handler/hltvDelayBuffer';

// ─── Core services ───────────────────────────────────────────────────────────

const recorder = new MatchRecorder(config.storage.matches_dir);
const metrics  = new MetricsCollector();
const hltvSync = new HltvSyncService(config.hltv_sync);

// Active-match reaper — matches that never get a clean ktp_match_end (plugin
// reload, changelevel, crash, rcon restart) would otherwise sit in
// activeMatches forever and show as "live" on /watch. A full competitive half
// is 20 min; any live match emits events continuously within that window, so
// 20 min of silence on a match_id is unambiguously abandoned.
const MATCH_STALE_MS = 20 * 60 * 1000;
const REAPER_TICK_MS = 60_000;
setInterval(() => recorder.reapStaleMatches(MATCH_STALE_MS), REAPER_TICK_MS);

// ─── Socket.IO (match-based rooms) ──────────────────────────────────────────

const { httpServer: socketHttp, io } = createSocketServer(config.frontend.origin, recorder);

// Buffer needs `io` for its onFire callback, so it's constructed after the
// socket server. The callback is required by the constructor — there's no
// setter — so the buffer can't be assembled in a half-wired state.
const fireToSockets = makeFireToSockets(io);
const delayBuffer = new HltvDelayBuffer(hltvSync, ({ server, matchId, event, enqueuedAt }) =>
    fireToSockets(server, matchId, event, enqueuedAt));

// Rescue events stranded by a changelevel on every fresh sample — see
// wireStrandedRescue for the full timing story (heartbeat self-healing of
// late-arriving old-half POSTs, coast exclusion, strand margin).
wireStrandedRescue(hltvSync, delayBuffer);

hltvSync.start();
delayBuffer.start();

socketHttp.listen(config.socket.port, () => {
    console.log(`[socket] Socket.IO server listening on port ${config.socket.port}`);
});

// ─── Express (REST API + ingest + metrics) ──────────────────────────────────

const app = express();

app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ limit: '1mb', extended: false }));
app.use(express.json({ limit: '1mb' }));
app.set('json spaces', 2);
app.disable('x-powered-by');
app.use(cors());

// NO caster-login route here on purpose. ktpleague.gg decides who may cast
// (it already knows who is logged in) and mints the token; this backend only
// verifies the signature on join_caster. See handler/casterAuth.ts.

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', active_matches: recorder.getActiveMatchIds().length });
});

// Metrics endpoint
app.get('/metrics', (_req, res) => {
    const snapshot = metrics.getSnapshot();
    snapshot.active_matches = recorder.getActiveMatchIds();
    res.json(snapshot);
});

// Server list — game servers that have sent events, fleet-ordered, each paired
// with the public HLTV proxy a viewer can connect to (see serverList.ts).
app.get('/api/servers', (_req, res) => {
    res.json({
        servers: buildServerList(metrics, config.hltv_connect, getServerPlayerCount),
    });
});

app.get('/api/matches/live', (_req, res) => {
    const active = recorder.getActiveMatchIds();
    const activeSet = new Set(active);
    res.json({
        active,
        matches: recorder.getAllMetadata().filter(m => activeSet.has(m.matchId)),
    });
});

app.get('/api/matches/stored', (_req, res) => {
    res.json({
        matches: recorder.listStoredMatches(),
    });
});

// HQ / Operations Board — one poll returns every reporting server's status,
// score, roster and clock for the wall display at /hq. Read-only projection over
// the state cache + recorder + metrics; shares no state or middleware with
// /ingest and nothing the broadcast overlay reads.
//
// PUBLIC AND UNAUTHENTICATED. The nginx vhost proxies /api/* straight through,
// so this answers 200 to anyone on the internet. The paragraph above describes
// how it is WIRED, not who can reach it, and it was read as "internal" by two
// separate reviewers on that basis (issue #19) — including by the people running
// the deployment. Player identity leaves here pseudonymized (see pseudonym.ts);
// treat every field added below as published.
app.get('/api/hq', (_req, res) => {
    res.json(buildHqOverview(recorder, metrics, hltvSync));
});

// Serve events.jsonl for a completed match (replay).
//
// PUBLIC AND UNAUTHENTICATED, like everything else on this vhost. events.jsonl
// keeps real SteamIDs on disk — it is the operator-owned record and the league
// stats join reads it — so the mapping happens HERE, on the way out, rather
// than at record time. Scope is the recording server, so a replayed id matches
// the token the live socket emitted for that same player.
app.get('/api/matches/:matchId/events', (req, res) => {
    const events = recorder.getEvents(req.params.matchId);
    if (!events) {
        res.status(404).json({ error: 'match not found or no events recorded' });
        return;
    }
    const scope = recorder.getMetadata(req.params.matchId)?.sourceServer ?? req.params.matchId;
    res.json({ events: pseudonymize(events, scope) });
});

// ---------------------------------------------------------------------------
// Historical stats, read-only, from the KTPHLStatsX `hlstatsx` MySQL database.
//
// Additive and entirely separate from the live overlay path: nothing here
// touches the socket feed, the HLTV delay buffer, the per-server state cache or
// MatchRecorder. It answers 503 when `stats_db.enabled` is false, which is the
// default and the case on every dev laptop — the database binds 127.0.0.1 on
// the data server, where production also runs this backend.
//
// These routes are ungated like the rest of /api/*. They expose per-player match
// statistics that are already public on the league site, and no credential,
// address or private coordinate is returned. Position samples deliberately have
// no route: the operator's standing direction is that individual coordinates and
// movement histories stay private.
const statsGuard = new StatsGuard();

/**
 * Cache lifetimes. A FINISHED match is immutable, so its box score can be held
 * for a long time; the recent-match list and a career total move, but slowly,
 * and neither is on the broadcast path where staleness would matter.
 */
const TTL_MATCH_LIST = 30_000;
const TTL_MATCH      = 300_000;      // historical browsing; the live overlay never reads this
const TTL_PLAYER     = 120_000;
const TTL_FLAGS      = 3_600_000;    // static per map

/**
 * Wraps a stats read in the full protection stack: enabled check, per-IP rate
 * limit, TTL cache, then the circuit breaker + concurrency cap.
 *
 * Every rejection path answers 503 with Retry-After rather than an error the
 * client might hammer. `guard.run` returning null means SHED — the request was
 * refused without touching MySQL, which is the entire point.
 *
 * `work` resolving to `undefined` means NOT FOUND (404) — distinct from a query
 * failure (502) and from shedding (503), so a caller can tell "no such player"
 * from "ask again later".
 */
async function serveStats(
    req: any, res: any, cacheKey: string, ttlMs: number, work: () => Promise<unknown>,
): Promise<void> {
    if (!statsDb.isEnabled()) {
        // `reason` is the machine-readable half: permanent, stop asking.
        res.status(503).json({
            reason: 'disabled',
            error: 'stats database not configured on this instance',
        });
        return;
    }

    const ip = String(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
    if (!statsGuard.allowRate(ip)) {
        res.set('Retry-After', '60').status(429).json({ error: 'rate limited' });
        return;
    }

    const cached = statsGuard.getCached(cacheKey);
    if (cached !== undefined) {
        res.set('X-Cache', 'HIT');
        res.json(cached);
        return;
    }

    try {
        const out = await statsGuard.run(work);
        if (out === null) {
            // Shed: breaker open, or too many already in flight. Say so plainly
            // — this is the "data server can't keep up, so stand down" path.
            // TRANSIENT. A client must back off and retry, not stand down for
            // good -- the breaker half-opens on its own and the concurrency cap
            // clears as soon as the in-flight queries finish.
            res.set('Retry-After', '30').status(503).json({
                reason: 'shedding',
                error: 'stats temporarily unavailable (load shedding)',
                breaker: statsGuard.getState(),
            });
            return;
        }
        if (out === undefined) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        statsGuard.setCached(cacheKey, out, ttlMs);
        res.set('X-Cache', 'MISS');
        res.json(out);
    } catch (err) {
        console.error('[statsdb] query failed:', (err as Error).message);
        res.status(502).json({ error: 'stats query failed' });
    }
}

app.get('/api/stats/matches', (req, res) => {
    const days  = Math.min(365, Math.max(1, parseInt(String(req.query.days  ?? '30'), 10) || 30));
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    serveStats(req, res, `matches:${days}:${limit}`, TTL_MATCH_LIST,
        async () => ({ matches: await statsDb.recentMatches(days, limit) }));
});

// `half = 0` rows are the stored match TOTAL, not a third half. Passed through
// as-is; a caller that sums every row double-counts the whole board.
// Historical box score for one league match. PUBLIC and unauthenticated like the
// rest of /api/*, and these rows carry `steam_id` straight from the league DB —
// measured leaking 36 real SteamIDs with names and full stats on a single prod
// request. Scope is the MATCH id, not a server hostname: there is no live server
// context here, and per-match scoping means a player's historical appearances
// cannot be linked to each other by token either.
app.get('/api/stats/matches/:matchId', (req, res) => {
    const id = req.params.matchId;
    serveStats(req, res, `match:${id}`, TTL_MATCH,
        async () => ({ rows: pseudonymize(await statsDb.matchPlayerStats(id), id) }));
});

// Career totals for a whole roster in ONE query and ONE cache entry. The caster
// page asks for twelve players at a time; looping the single-player route would
// mean twelve queries against a data server that also carries MySQL for the
// league, the HLStatsX daemon, the HLTV proxies and this backend.
//
// Absent ids mean "no league matches recorded", which is not an error: the reply
// is a map, always 200, and a caller reads a missing key as unknown.
app.get('/api/stats/players', (req, res) => {
    const ids = String(req.query.ids ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    if (!ids.length) {
        res.status(400).json({ error: 'ids query parameter required (comma-separated SteamIDs)' });
        return;
    }
    const unique = Array.from(new Set(ids));
    if (unique.length > MAX_CAREER_BATCH) {
        res.status(400).json({ error: `at most ${MAX_CAREER_BATCH} ids per request` });
        return;
    }

    // The resolve half of the pseudonym boundary, and the reason /caster keeps
    // working without ever holding a SteamID: the page passes back the same
    // opaque tokens it got over the socket, and the real ids are recovered here,
    // in-process, purely to build the MySQL query.
    //
    // A token this process never minted (one from before a restart, or invented)
    // simply drops out. That is the existing contract, not a new failure mode —
    // the reply is a map, and an absent key already means "no league match
    // recorded", which the panel renders as no record rather than as an error.
    const pairs = unique
        .map(token => ({ token, steam: resolvePlayerId(token) }))
        .filter((p): p is { token: string; steam: string } => p.steam !== undefined);

    if (!pairs.length) {
        res.json({ players: {} });
        return;
    }

    // Cache key stays in TOKEN space. Keying on the resolved SteamIDs would let
    // one client's cached response — which is keyed BY TOKEN — be served to a
    // client holding different tokens for the same players, handing back rows it
    // could not look up. Tokens are stable per process, so two clients watching
    // the same server still share the entry, which is the case that matters.
    //
    // Sorted so two clients asking for the same roster in different orders share
    // the cache entry instead of each paying for a query.
    const key = `careers:${[...unique].sort().join(',')}`;
    serveStats(req, res, key, TTL_PLAYER, async () => ({
        players: rekeyByToken(await statsDb.playerCareers(pairs.map(p => p.steam)), pairs),
    }));
});

// Single-player career. Takes an opaque TOKEN, not a SteamID.
//
// It has no frontend consumer (the Career panel uses the batch form) and is kept
// for diagnostics — but as a public route accepting a raw SteamID it was an
// oracle: anyone could ask this backend whether a given SteamID plays in the
// league, and read their record, without ever seeing the id on our wire. Taking
// only tokens means a caller has to have been given the id by us to ask about
// it, which closes that without changing what a legitimate caller can do.
app.get('/api/stats/players/:playerId', (req, res) => {
    const token = req.params.playerId;
    const steam = resolvePlayerId(token);
    if (!steam) {
        res.status(404).json({ error: 'unknown player id' });
        return;
    }
    serveStats(req, res, `player:${token}`, TTL_PLAYER, async () => {
        const row = await statsDb.playerCareer(steam);
        return row ? { ...row, steam_id: token } : undefined;
    });
});

// Static per-flag world coordinates for a map (2D — dodx exposes no CP_origin_z).
app.get('/api/stats/maps/:mapName/flags', (req, res) => {
    const m = req.params.mapName;
    serveStats(req, res, `flags:${m}`, TTL_FLAGS,
        async () => ({ flags: await statsDb.flagPositions(m) }));
});

// Guard diagnostics — breaker state, shed counts, cache size. Read-only.
app.get('/api/stats/_guard', (_req, res) => {
    res.json({ enabled: statsDb.isEnabled(), ...statsGuard.snapshot() });
});

// HLTV sync: status, manual resample, calibration, drift push from hltv-api.py.
// Mutating endpoints are gated by the same X-Auth-Key as /ingest.
app.get('/api/hltv/status', (_req, res) => {
    const servers = hltvSync.getStatus().map((s: any) => ({
        ...s,
        queueDepth: delayBuffer.queueDepth(s.server),
    }));
    res.json({ enabled: config.hltv_sync.enabled, servers });
});
app.post('/api/hltv/resample/:server', async (req, res) => {
    if (req.headers['x-auth-key'] !== config.ingest.auth_key) { res.status(401).json({ error: 'unauthorized' }); return; }
    const server = req.params.server;
    if (!hltvSync.isActive(server)) { res.status(404).json({ error: 'server not configured for hltv_sync' }); return; }
    const clock = await hltvSync.sample(server, 'manual');
    res.json({ ok: true, clock });
});
app.put('/api/hltv/calibration/:server', (req, res) => {
    if (req.headers['x-auth-key'] !== config.ingest.auth_key) { res.status(401).json({ error: 'unauthorized' }); return; }
    const offsetMs = Number(req.body?.offsetMs);
    if (!Number.isFinite(offsetMs)) { res.status(400).json({ error: 'offsetMs (number) required' }); return; }
    hltvSync.setCalibrationOffsetMs(req.params.server, offsetMs);
    res.json({ ok: true, offsetMs });
});
app.post('/api/hltv/drift', async (req, res) => {
    if (req.headers['x-auth-key'] !== config.ingest.auth_key) { res.status(401).json({ error: 'unauthorized' }); return; }
    const server = req.body?.server;
    if (!server || !hltvSync.isActive(server)) { res.status(404).json({ error: 'server not configured for hltv_sync' }); return; }
    const clock = await hltvSync.sample(server, `drift:${req.body?.event ?? 'unknown'}`);
    res.json({ ok: true, clock });
});

// Event ingest from AMXX plugin
app.use('/ingest', createIngestRouter(config.ingest.auth_key, recorder, io, metrics, delayBuffer, hltvSync));

// ─── Start HTTP servers ─────────────────────────────────────────────────────

// Ingest server on its own port (8088 — firewalled to game server IPs in prod)
const ingestApp = express();
ingestApp.use(express.json({ limit: '1mb' }));
ingestApp.use('/ingest', createIngestRouter(config.ingest.auth_key, recorder, io, metrics, delayBuffer, hltvSync));
ingestApp.get('/health', (_req, res) => res.json({ status: 'ok' }));

ingestApp.listen(config.ingest.port, () => {
    console.log(`[ingest] HTTP ingest server listening on port ${config.ingest.port}`);
});

// API server (3001 — serves REST API, metrics, match list)
app.listen(config.api.port, () => {
    console.log(`[api] REST API server listening on port ${config.api.port}`);
});

console.log(`[config] Auth key: ${config.ingest.auth_key === 'changeme' ? '⚠ DEFAULT (change me!)' : '***set***'}`);
// Shared with ktpleague.gg, which signs caster tokens with it. A default
// here means every forged token verifies, so it is called out like the
// ingest key above rather than left to a config review.
console.log(`[config] Caster token secret: ${config.caster_auth.session_secret === 'changeme' ? '⚠ DEFAULT (change me!) — caster room is effectively open' : '***set***'}`);
console.log(`[config] Position gating: ${config.caster_auth.gate_positions ? 'ON — positions are caster-only' : 'off — positions are public, as before'}`);
console.log(`[config] Matches dir: ${path.resolve(config.storage.matches_dir)}`);
