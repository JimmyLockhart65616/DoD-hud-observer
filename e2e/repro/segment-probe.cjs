// HLTV↔overlay SEGMENT-DECOMPOSITION probe — prod- or local-pointable.
//
// The workhorse for the sync investigation (see e2e/repro/SYNC-MEASUREMENT.md).
// At one wall instant it reads every machine-measurable segment of the chain and
// tabulates the offsets, so the overlay↔footage gap is attributable to a
// component instead of a black box.
//
// Per sample it reads:
//   • backend  GET {api}/api/hltv/status → broadcastNow, activeTime, delaySeconds,
//              sampleAgeMs, lastEventTick, queueDepth, calibrationOffsetMs, online, map
//   • overlay  Socket.IO snapshot join to {socket} → the age-adjusted time_sync
//              timeleft a fresh OBS browser source anchors to (= the HUD timer)
//   • proxy    rcon `status` on the MASTER (--hltv) → Game Time (≈live) + Delay
//   • relay    rcon `status` on a chained delay-0 RELAY (--relay) → Game Time
//              (= the master's broadcast SERVE point; machine-reads the footage side)
//
// Derived columns (formulas + healthy values in lib/sync-math.cjs):
//   oLag    overlayLag = lastEventTick − broadcastNow          (≈ delay)
//   cErr    broadcastNow − (lastEventTick − delay)             (≈ POST latency)
//   cErrPx  broadcastNow − (proxyGameTime − delay)             (≈ 0; drift = host clock skew)
//   srvDel  proxyGameTime − relayGameTime                      (master's true serve-delay)
//   rVsO    relayGameTime − broadcastNow  ── THE discriminator (≈0 client-side, ≪0 proxy-side)
//   STEP    broadcastNow jump >2s w/o tick reset               (failed-sample-resume)
//   yourCl  blank — hand-read your DoD client clock here for the footage spot-check
//
// Usage:
//   node e2e/repro/segment-probe.cjs ["KTP - Atlanta 1"]
//        [--api http://74.91.112.242:3001] [--socket http://74.91.112.242:4000]
//        [--hltv 127.0.0.1:27020]  [--hltv-pw  <master adminpassword>]
//        [--relay 127.0.0.1:27060] [--relay-pw <relay  adminpassword>]
//        [--interval 0]   # 0 = single shot (default); >0 = repeat every N ms
//        [--csv <path>]
// Passwords are never printed (redacted to ***). rcon segments are skipped if no
// password is given for them.
'use strict';
const http = require('http');
const fs = require('fs');
const { io } = require('socket.io-client');
const { rconHltvStatus, splitHostPort } = require('./lib/rcon.cjs');
const M = require('./lib/sync-math.cjs');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SERVER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'KTP - Atlanta 1';
const API = arg('--api', 'http://74.91.112.242:3001');
const SOCKET = arg('--socket', 'http://74.91.112.242:4000');
const HLTV = arg('--hltv', null);
const HLTV_PW = arg('--hltv-pw', null);
const RELAY = arg('--relay', null);
const RELAY_PW = arg('--relay-pw', null);
const INTERVAL = parseInt(arg('--interval', '0'), 10);
const CSV = arg('--csv', null);
const RCON_TIMEOUT = 4000;

const fmt = (v, w) => (v == null ? '-' : typeof v === 'number' ? v.toFixed(1) : String(v)).padStart(w);
const COLS = [
    ['time', 8], ['map', 14], ['onl', 4], ['delay', 5], ['bcastNow', 9], ['lastTick', 9],
    ['HUD', 7], ['proxyGT', 8], ['relayGT', 8], ['oLag', 6], ['cErrPx', 7], ['srvDel', 7],
    ['rVsO', 7], ['STEP', 7], ['yourCl', 8],
];

function httpJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 6000 }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('http timeout')));
        req.on('error', reject);
    });
}

// Join the prod Socket.IO server like a fresh overlay; capture the snapshot's
// age-adjusted time_sync.timeleft (what the HUD anchors to). null on failure.
function snapshotTimeleft() {
    return new Promise((resolve) => {
        const socket = io(SOCKET, { transports: ['websocket'], reconnection: false, timeout: 5000 });
        let tl = null;
        socket.onAny((event, raw) => {
            let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
            if (event === 'time_sync' && tl == null && e && e.timeleft != null) tl = e.timeleft;
        });
        socket.on('connect', () => socket.emit('join_server', SERVER));
        socket.on('connect_error', () => { try { socket.close(); } catch (_) {} resolve(null); });
        setTimeout(() => { try { socket.close(); } catch (_) {} resolve(tl); }, 2000);
    });
}

let prevBcast = null, prevTick = null, prevMs = null, printedHeader = false;

async function sample() {
    const ts = new Date().toTimeString().slice(0, 8);

    // backend status
    let s = null;
    try {
        const j = await httpJson(`${API}/api/hltv/status`);
        s = (j.servers || []).find((x) => x.server === SERVER) || null;
    } catch (_) {}

    // overlay snapshot + proxy/relay rcon (in parallel)
    const [hud, proxy, relay] = await Promise.all([
        snapshotTimeleft(),
        HLTV && HLTV_PW ? rconHltvStatus(...splitHostPort(HLTV), HLTV_PW, RCON_TIMEOUT) : Promise.resolve(null),
        RELAY && RELAY_PW ? rconHltvStatus(...splitHostPort(RELAY), RELAY_PW, RCON_TIMEOUT) : Promise.resolve(null),
    ]);

    if (!s) { console.log(`${ts}  (server "${SERVER}" not found / backend unreachable)`); return { lag: null }; }

    const bcast = typeof s.broadcastNow === 'number' ? s.broadcastNow : null;
    const lastTick = s.lastEventTick ?? null;
    const delay = s.delaySeconds ?? null;
    const calib = s.calibrationOffsetMs ?? 0;
    const ageS = s.sampleAgeMs != null ? s.sampleAgeMs / 1000 : null;
    const proxyGT = proxy && !proxy.error ? proxy.gameTime : null;
    const relayGT = relay && !relay.error ? relay.gameTime : null;

    const oLag = M.overlayLag(lastTick, bcast);
    const cErr = M.clockErr(bcast, lastTick, delay);
    const cErrPx = M.clockErrPx(bcast, proxyGT, delay);
    const srvDel = M.proxySrvDelay(proxyGT, relayGT);
    const rVsO = M.relayVsOverlay(relayGT, bcast);
    // STEP tolerance uses ACTUAL elapsed wall-time, not the configured interval:
    // each sample's own latency (http + the 2s socket snapshot + rcon) inflates the
    // real gap well past --interval, which would otherwise trip a false STEP.
    const nowMs = Date.now();
    const elapsedMs = prevMs != null ? nowMs - prevMs : INTERVAL;
    const step = M.detectStep(prevBcast, bcast, prevTick, lastTick, elapsedMs);
    const stepStr = step.isStep ? `${step.jump > 0 ? '+' : ''}${step.jump.toFixed(1)}` : '';
    prevBcast = bcast; prevTick = lastTick; prevMs = nowMs;

    if (!printedHeader) {
        console.log(`server="${SERVER}"  api=${API}  socket=${SOCKET}`);
        console.log(`proxy=${HLTV || '(none)'} pw=${HLTV_PW ? '***' : '-'}   relay=${RELAY || '(none)'} pw=${RELAY_PW ? '***' : '-'}`);
        console.log(COLS.map(([h, w]) => h.padStart(w)).join(' '));
        printedHeader = true;
    }
    console.log([
        ts.padStart(8), String(s.map ?? '-').padStart(14), String(s.online).padStart(4),
        fmt(delay, 5), fmt(bcast, 9), fmt(lastTick, 9), fmt(hud, 7), fmt(proxyGT, 8), fmt(relayGT, 8),
        fmt(oLag, 6), fmt(cErrPx, 7), fmt(srvDel, 7), fmt(rVsO, 7), stepStr.padStart(7), '   _:__'.padStart(8),
    ].join(' '));

    if (CSV) {
        if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, 'wallMs,server,map,online,activeTime,delay,broadcastNow,sampleAgeS,lastEventTick,queueDepth,calibMs,hudTimeleft,proxyGameTime,relayGameTime,overlayLag,clockErr,clockErrPx,proxySrvDelay,relayVsOverlay,step,yourClientTimeleft\n');
        fs.appendFileSync(CSV, [
            Date.now(), SERVER, s.map, s.online, s.activeTime, delay, bcast, ageS, lastTick, s.queueDepth,
            calib, hud, proxyGT, relayGT, oLag, cErr, cErrPx, srvDel, rVsO, step.isStep ? step.jump : '', '',
        ].join(',') + '\n');
    }
    return { lag: oLag, hud, rVsO, srvDel };
}

(async () => {
    const r = await sample();
    if (INTERVAL > 0) { setInterval(sample, INTERVAL); return; }
    console.log('');
    console.log(`overlayLag (lastTick − bcastNow) = ${r.lag != null ? r.lag.toFixed(1) : '?'}s  → should ≈ delay`);
    if (r.rVsO != null) {
        console.log(`DISCRIMINATOR relayGT − bcastNow = ${r.rVsO.toFixed(1)}s  (master serve-delay = ${r.srvDel != null ? r.srvDel.toFixed(1) : '?'}s)`);
        console.log(`  ≈0 ⇒ overlay matches master serve point; gap to footage is CLIENT-side (per-session calibration).`);
        console.log(`  ≪0 ⇒ master serves further back than overlay; gap is PROXY-side (mechanism reference wrong, auto-fixable).`);
    } else {
        console.log(`(no relay sampled — pass --relay host:port --relay-pw <pw> to measure the master serve point)`);
    }
    console.log(`spectatorGap = yourClientTimeleft − HUD(${r.hud != null ? r.hud : '?'}s): read your DoD client clock NOW and subtract. >0 ⇒ overlay AHEAD.`);
    process.exit(0);
})();
