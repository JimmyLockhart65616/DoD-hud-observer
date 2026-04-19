import express from 'express';
import path from 'path';
import cors from 'cors';
import config from './config';
import { MatchRecorder } from './handler/matchRecorder';
import { MetricsCollector } from './handler/metrics';
import { createIngestRouter } from './handler/ingest';
import { createSocketServer } from './socket/socket';

// ─── Core services ───────────────────────────────────────────────────────────

const recorder = new MatchRecorder(config.storage.matches_dir);
const metrics  = new MetricsCollector();

// ─── Socket.IO (match-based rooms) ──────────────────────────────────────────

const { httpServer: socketHttp, io } = createSocketServer(config.frontend.origin, recorder);

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
    res.json({ servers: metrics.getServers() });
});

app.get('/api/matches/live', (_req, res) => {
    res.json({
        active: recorder.getActiveMatchIds(),
        matches: recorder.getAllMetadata(),
    });
});

app.get('/api/matches/stored', (_req, res) => {
    res.json({
        matches: recorder.listStoredMatches(),
    });
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

// Event ingest from AMXX plugin
app.use('/ingest', createIngestRouter(config.ingest.auth_key, recorder, io, metrics));

// ─── Start HTTP servers ─────────────────────────────────────────────────────

// Ingest server on its own port (8088 — firewalled to game server IPs in prod)
const ingestApp = express();
ingestApp.use(express.json({ limit: '1mb' }));
ingestApp.use('/ingest', createIngestRouter(config.ingest.auth_key, recorder, io, metrics));
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
