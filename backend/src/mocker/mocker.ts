/**
 * DoD HUD Observer — Event Mocker
 *
 * Two modes:
 *   npm run mocker          — HTTP mode: POSTs events to /ingest (backend must be running)
 *   npm run mocker:socket   — Socket mode: direct Socket.IO emit (no backend needed, legacy)
 *
 * HTTP mode exercises the full pipeline: ingest → MatchRecorder → Socket.IO rooms → frontend.
 * Socket mode is a shortcut for frontend-only dev (frontend connects directly to mocker:8000).
 *
 * Plugin parity: real KTPHudObserver.amxx wraps every emit with `tick` and `plugin_sent_at`
 * (see KTPHudObserver.sma post_event() lines 186-217). The mocker does the same here so
 * downstream code sees identical event envelopes. It also re-polls flag_zone_players on a
 * 1s timer between scripted updates to mimic the plugin's task_poll_zones() cadence.
 */
import MockerClass from './MockerClass';

const mode = process.argv.includes('--socket') ? 'socket' : 'http';
const MATCH_ID = `KTP-${Date.now()}-dod_anzio-test`;
const MOCKER_START = Date.now();

// Last-known zone state, mirrored from any flag_zone_players we author in data.ts.
// Re-emitted on a 1s tick so the frontend stays under realistic event pressure.
let lastZones: unknown[] | null = null;

const mocker = new MockerClass();

if (mode === 'http') {
    startHttpMode();
} else {
    startSocketMode();
}

// ─── Plugin envelope ───────────────────────────────────────────────────────
//
// post_event() in the SMA injects tick (gametime), plugin_sent_at (systime ms), and
// when a match is active: match_id, map, match_type, half. Mirror that envelope here.
function wrapEnvelope(eventName: string, payload: Record<string, unknown>): Record<string, unknown> {
    const tick = (Date.now() - MOCKER_START) / 1000;
    return {
        tick: Number(tick.toFixed(2)),
        match_id: MATCH_ID,
        map: 'dod_anzio',
        match_type: 1,
        half: 1,
        plugin_sent_at: Date.now(),
        event: eventName,
        ...payload,
    };
}

// ─── HTTP mode: POST to /ingest ─────────────────────────────────────────────

async function startHttpMode() {
    const INGEST_URL = process.env.MOCKER_INGEST_URL ?? 'http://localhost:8088/ingest';
    const AUTH_KEY   = process.env.MOCKER_AUTH_KEY   ?? 'changeme';

    console.log(`[mocker] HTTP mode — posting to ${INGEST_URL}`);
    console.log(`[mocker] Match ID: ${MATCH_ID}`);

    // ktp_match_start opens the recorder. This is the KTPMatchHandler forward, not a
    // plugin-emitted event, so it skips the standard envelope.
    await postRaw({
        event: 'ktp_match_start',
        match_id: MATCH_ID,
        map: 'dod_anzio',
        match_type: 1,
        half: 1,
    }, INGEST_URL, AUTH_KEY);

    mocker.on('action', async (info: [string | string[], Record<string, unknown>]) => {
        const eventName = Array.isArray(info[0]) ? info[0][0] : info[0];
        const payload = info[1];

        if (eventName === 'flag_zone_players' && Array.isArray(payload.zones)) {
            lastZones = payload.zones as unknown[];
        }

        try {
            await postRaw(wrapEnvelope(eventName, payload), INGEST_URL, AUTH_KEY);
        } catch (err) {
            console.error(`[mocker] POST failed: ${(err as Error).message}`);
        }
    });

    // Mimic plugin's task_poll_zones() (10Hz live; 1Hz here is plenty for visual testing).
    setInterval(() => {
        if (!lastZones) return;
        postRaw(wrapEnvelope('flag_zone_players', { zones: lastZones }), INGEST_URL, AUTH_KEY)
            .catch(err => console.error(`[mocker] zone re-poll failed: ${(err as Error).message}`));
    }, 1000);

    console.log('[mocker] Starting event sequence...');
    mocker.start();
}

async function postRaw(
    data: Record<string, unknown>,
    url: string,
    authKey: string,
): Promise<void> {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Auth-Key': authKey,
            'X-Server-Hostname': 'mocker',
        },
        body: JSON.stringify(data),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    console.log(`[mocker] → ${data.event as string}`);
}

// ─── Socket mode: direct Socket.IO emit (legacy) ───────────────────────────

function startSocketMode() {
    const { createServer } = require('http');
    const { Server } = require('socket.io');

    const httpServer = createServer();
    const io = new Server(httpServer, {
        cors: {
            origin: 'http://localhost:3000',
            methods: ['GET', 'POST'],
            credentials: true,
        },
    });

    let started = false;

    mocker.on('action', (info: [string | string[], Record<string, unknown>]) => {
        const eventName = Array.isArray(info[0]) ? info[0][0] : info[0];
        const payload = info[1];

        if (eventName === 'flag_zone_players' && Array.isArray(payload.zones)) {
            lastZones = payload.zones as unknown[];
        }

        const wrapped = wrapEnvelope(eventName, payload);
        console.log(`[mocker] → ${eventName}`);
        io.emit(eventName, JSON.stringify(wrapped));
    });

    setInterval(() => {
        if (!lastZones) return;
        const wrapped = wrapEnvelope('flag_zone_players', { zones: lastZones });
        io.emit('flag_zone_players', JSON.stringify(wrapped));
    }, 1000);

    io.on('connection', (socket: any) => {
        console.log(`[mocker] Client connected: ${socket.id}`);
        if (!started) {
            started = true;
            console.log('[mocker] First client connected — starting event sequence');
            mocker.start();
        }
    });

    httpServer.listen(8000, () => {
        console.log('[mocker] Socket mode — waiting for client on port 8000...');
    });
}
