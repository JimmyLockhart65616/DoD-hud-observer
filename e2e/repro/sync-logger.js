#!/usr/bin/env node
// Durable HLTV↔overlay SYNC MONITOR for the data server.
//
// For each watched server it logs, every tick, one timestamped CSV row combining:
//   • backend  GET /api/hltv/status → online, lastError, sampleAgeMs, delay,
//              broadcastNow, lastEventTick, lag(=lastTick−broadcastNow), queueDepth, calib
//   • relay    a local delay-0 relay chained to that server's proxy (footage serve
//              point) → relayGameTime, proxySrvDelay(=lastTick−relayGT),
//              relayVsOverlay(=relayGT−broadcastNow)  ← the direct overlay-vs-footage gap
//   • overlay  a persistent Socket.IO connection (like a real OBS source) → the
//              frontend's locally-counted timer + time_sync cadence (wedge watch)
//
// It flags anomalies (also to stdout → journald) so when a skew is reported at
// time T, the CSV around T shows exactly what slipped: a coast (OFFLINE/RCONERR/
// growing sampleAge), a proxy lag (LAGDEV), a resample jump (STEP), the footage
// diverging (RVO_SPIKE), a dropped relay (RELAY_DOWN), or a time_sync wedge (WEDGE).
//
// Deps: dgram + http (builtin) + socket.io-client (optional; via NODE_PATH to the
// backend's node_modules). Logs rotate daily: <LOG_DIR>/sync-YYYY-MM-DD.csv.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { rconHltvStatus } = require('./lib/rcon.cjs');
const M = require('./lib/sync-math.cjs');
let ioClient = null;
try { ioClient = require('socket.io-client').io; } catch (_) { /* cadence disabled if absent */ }

const API = process.env.SYNC_API || 'http://127.0.0.1:3001';
const SOCKET = process.env.SYNC_SOCKET || 'http://127.0.0.1:4000';
const RELAY_PW = process.env.SYNC_RELAY_PW || 'syncrelay';
const INTERVAL = parseInt(process.env.SYNC_INTERVAL || '10000', 10);
const LOG_DIR = process.env.SYNC_LOG_DIR || path.join(__dirname, 'logs');

// Watched servers → their local relay port (relay chained to each proxy).
const SERVERS = [
    { name: 'KTP - Chicago 1', relay: 27060 },
    { name: 'KTP - New York 1', relay: 27061 },
    { name: 'KTP - Atlanta 1', relay: 27062 },
];
// Anomaly thresholds (seconds unless noted).
const T = { lagDev: 5, rvoSpike: 8, wedge: 45, drift: 3 };

fs.mkdirSync(LOG_DIR, { recursive: true });
const st = {};
SERVERS.forEach((s) => { st[s.name] = { prevB: null, prevT: null, prevMs: null, anchorTl: null, anchorAt: null, lastSyncAt: null, syncCount: 0, prevOnline: null }; });

// Persistent overlay sockets for time_sync cadence + frontend countdown.
if (ioClient) {
    for (const s of SERVERS) {
        const sock = ioClient(SOCKET, { transports: ['websocket'], reconnection: true });
        sock.on('connect', () => sock.emit('join_server', s.name));
        sock.onAny((event, raw) => {
            if (event !== 'time_sync' && event !== 'round_start' && event !== 'half_start') return;
            let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
            if (!e || e.timeleft == null) return;
            const a = st[s.name];
            a.anchorTl = e.timeleft; a.anchorAt = Date.now();
            if (event === 'time_sync') { a.lastSyncAt = Date.now(); a.syncCount++; }
        });
    }
}

const CSV_HEADER = 'wallMs,iso,server,map,online,lastError,sampleAgeMs,delay,broadcastNow,lastEventTick,lag,queueDepth,calibMs,relayGameTime,proxySrvDelay,relayVsOverlay,relayConnected,frontendDisplayed,sinceLastSyncS,syncCount,stepJump,flags\n';
const logFile = () => path.join(LOG_DIR, `sync-${new Date().toISOString().slice(0, 10)}.csv`);
function append(row) { const f = logFile(); if (!fs.existsSync(f)) fs.writeFileSync(f, CSV_HEADER); fs.appendFileSync(f, row + '\n'); }

function httpJson(url) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: 8000 }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (_) { resolve(null); } }); });
        req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
    });
}

async function tick() {
    const status = await httpJson(`${API}/api/hltv/status`);
    const byName = {}; (status && status.servers || []).forEach((s) => { byName[s.server] = s; });
    await Promise.all(SERVERS.map(async (srv) => {
        const a = st[srv.name];
        const s = byName[srv.name] || null;
        const relay = await rconHltvStatus('127.0.0.1', srv.relay, RELAY_PW, 4000).catch(() => null);
        const now = Date.now();
        const bcast = s && typeof s.broadcastNow === 'number' ? s.broadcastNow : null;
        const lastTick = s ? (s.lastEventTick != null ? s.lastEventTick : null) : null;
        const delay = s ? (s.delaySeconds != null ? s.delaySeconds : null) : null;
        const lag = M.overlayLag(lastTick, bcast);
        const relayGT = relay && !relay.error && relay.gameTime != null ? relay.gameTime : null;
        const relayConn = !!(relay && relay.raw && /Connected to/.test(relay.raw));
        const srvDel = M.proxySrvDelay(lastTick, relayGT);
        const rvo = M.relayVsOverlay(relayGT, bcast);
        const elapsedMs = a.prevMs != null ? now - a.prevMs : INTERVAL;
        const step = M.detectStep(a.prevB, bcast, a.prevT, lastTick, elapsedMs);
        const displayed = (a.anchorTl != null && a.anchorAt != null) ? Math.max(0, a.anchorTl - Math.floor((now - a.anchorAt) / 1000)) : null;
        const sinceSync = a.lastSyncAt != null ? (now - a.lastSyncAt) / 1000 : null;

        const flags = [];
        if (s && s.online === false) flags.push('OFFLINE');
        if (s && s.lastError) flags.push('RCONERR');
        if (lag != null && delay != null && Math.abs(lag - delay) > T.lagDev) flags.push('LAGDEV');
        if (step.isStep) flags.push('STEP');
        if (rvo != null && Math.abs(rvo) > T.rvoSpike) flags.push('RVO_SPIKE');
        if (s && !relayConn) flags.push('RELAY_DOWN');
        if (sinceSync != null && sinceSync > T.wedge) flags.push('WEDGE');
        if (a.prevOnline === true && s && s.online === false) flags.push('ONLINE_FLIP');

        a.prevB = bcast; a.prevT = lastTick; a.prevMs = now; a.prevOnline = s ? s.online : a.prevOnline;

        const esc = (v) => (v == null ? '' : String(v).replace(/,/g, ';'));
        const r2 = (v) => (v == null ? '' : Math.round(v * 100) / 100);
        append([now, new Date(now).toISOString(), srv.name, s ? esc(s.map) : '', s ? s.online : '', s ? esc(s.lastError) : '',
            s ? s.sampleAgeMs : '', delay == null ? '' : delay, r2(bcast), r2(lastTick), r2(lag), s ? s.queueDepth : '', s ? s.calibrationOffsetMs : '',
            relayGT == null ? '' : relayGT, r2(srvDel), r2(rvo), relayConn, displayed == null ? '' : displayed,
            sinceSync != null ? sinceSync.toFixed(1) : '', a.syncCount, step.isStep ? step.jump.toFixed(1) : '', flags.join('|')].join(','));
        if (flags.length) console.log(`[${new Date(now).toISOString()}] ${srv.name} ANOMALY ${flags.join(',')} lag=${lag != null ? lag.toFixed(1) : '-'} rvo=${rvo != null ? rvo.toFixed(1) : '-'} online=${s ? s.online : '?'} sinceSync=${sinceSync != null ? sinceSync.toFixed(0) : '-'}s`);
    })).catch((e) => console.log(`[sync-logger] tick error: ${e.message}`));
}

console.log(`[sync-logger] start: ${SERVERS.map((s) => s.name + '@' + s.relay).join(', ')} interval=${INTERVAL}ms logDir=${LOG_DIR} cadence=${ioClient ? 'on' : 'off'}`);
tick();
setInterval(tick, INTERVAL);
process.on('SIGTERM', () => { console.log('[sync-logger] SIGTERM'); process.exit(0); });
