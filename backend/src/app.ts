import express from 'express';
import path from 'path';
import cors from 'cors';
import config from './config';
import * as statsDb from './statsdb/statsDb';
import { StatsGuard } from './statsdb/guard';
import { MatchRecorder } from './handler/matchRecorder';
import { MetricsCollector } from './handler/metrics';
import { createIngestRouter, getServerPlayerCount, makeFireToSockets } from './handler/ingest';
import { buildHqOverview } from './handler/hqBoard';
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
const delayBuffer = new HltvDelayBuffer(hltvSync, ({ server, matchId, event }) =>
    fireToSockets(server, matchId, event));

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

// Server list — game servers that have sent events
app.get('/api/servers', (_req, res) => {
    const servers = metrics.getServers().map(({ last_seen: _last, ...rest }) => ({
        ...rest,
        players: getServerPlayerCount(rest.hostname),
    }));
    res.json({ servers });
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
app.get('/api/hq', (_req, res) => {
    res.json(buildHqOverview(recorder, metrics, hltvSync));
});

// Serve events.jsonl for a completed match (replay)
app.get('/api/matches/:matchId/events', (req, res) => {
    const events = recorder.getEvents(req.params.matchId);
    if (!events) {
        res.status(404).json({ error: 'match not found or no events recorded' });
        return;
    }
    res.json({ events });
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
        res.status(503).json({ error: 'stats database not configured on this instance' });
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
            res.set('Retry-After', '30').status(503).json({
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
app.get('/api/stats/matches/:matchId', (req, res) => {
    const id = req.params.matchId;
    serveStats(req, res, `match:${id}`, TTL_MATCH,
        async () => ({ rows: await statsDb.matchPlayerStats(id) }));
});

app.get('/api/stats/players/:steamId', (req, res) => {
    const id = req.params.steamId;
    serveStats(req, res, `player:${id}`, TTL_PLAYER,
        async () => (await statsDb.playerCareer(id)) ?? undefined);
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
console.log(`[config] Matches dir: ${path.resolve(config.storage.matches_dir)}`);
