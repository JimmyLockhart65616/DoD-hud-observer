import express from 'express';
import path from 'path';
import cors from 'cors';
import config from './config';
import { MatchRecorder } from './handler/matchRecorder';
import { MetricsCollector } from './handler/metrics';
import { createIngestRouter, getServerPlayerCount, makeFireToSockets } from './handler/ingest';
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
