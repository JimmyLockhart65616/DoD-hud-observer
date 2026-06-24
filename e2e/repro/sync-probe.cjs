// Steady-state HLTV↔overlay sync probe for the local full-stack repro.
//
// Every interval, at one wall instant, samples three clocks and tabulates the
// offset so each steady-state gap is visible/quantified:
//   1. backend  GET /api/hltv/status  → broadcastNow, activeTime, delaySeconds,
//      sampleAgeMs, online, queueDepth, lastEventTick (the latest game tick the
//      backend has received from the plugin = the live game clock, lagged only
//      by POST latency).
//   2. HLTV proxy `status` via UDP rcon → "Game Time" (proxy World time) + Delay.
//      An INDEPENDENT read of the proxy clock — cross-checks that the backend's
//      cached activeTime hasn't gone stale.
//
// Derived columns:
//   clockErr   = broadcastNow − (lastEventTick − delay)
//                ≈ POST latency (~1–2s) in steady state; a large/growing value
//                is a real offset bug.
//   clockErrPx = broadcastNow − (hltvGameTime_live − delay)
//                our broadcast clock vs where the PROXY's own clock says the feed
//                is. ~0 ± (sampleAge drift + 1s activeTime quantization) is healthy
//                (gap 4). This is the cleanest steady-state offset measure.
//   STEP       = broadcastNow jumped > 2s between consecutive samples with no
//                lastEventTick reset → the gap-3 (failed-sample resume) signature.
//
// Usage:
//   node e2e/repro/sync-probe.cjs [--server "KTP Local Dev #1"] [--api http://localhost:3001]
//        [--hltv 127.0.0.1:27020] [--hltv-pw localdev-rcon] [--interval 2000] [--csv path]
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const SERVER = arg('--server', 'KTP Local Dev #1');
const API = arg('--api', 'http://localhost:3001');
const HLTV = arg('--hltv', '127.0.0.1:27020');
const HLTV_PW = arg('--hltv-pw', 'localdev-rcon');
const INTERVAL = parseInt(arg('--interval', '2000'), 10);
const CSV = arg('--csv', null);
const [HLTV_HOST, HLTV_PORT] = [HLTV.split(':')[0], parseInt(HLTV.split(':')[1], 10)];
const RCON_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function httpJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 4000 }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('http timeout')));
        req.on('error', reject);
    });
}

function rconStatus() {
    // Two-stage GoldSrc UDP rcon: challenge → `status`. Returns { gameTime, delay } or null.
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch (e) {} resolve(v); } };
        const timer = setTimeout(() => finish(null), 3000);
        sock.once('message', (ch) => {
            const m = ch.toString('binary').match(/challenge rcon (-?\d+)/);
            if (!m) return finish(null);
            sock.once('message', (reply) => {
                clearTimeout(timer);
                const text = reply.slice(5).toString('utf8');
                const gt = text.match(/Game Time (\d+):(\d+)/);
                const dl = text.match(/Delay (\d+)/);
                finish(gt ? { gameTime: parseInt(gt[1], 10) * 60 + parseInt(gt[2], 10), delay: dl ? parseInt(dl[1], 10) : null } : null);
            });
            sock.send(Buffer.concat([RCON_PREFIX, Buffer.from(`rcon ${m[1]} ${HLTV_PW} status\n\0`)]), HLTV_PORT, HLTV_HOST, (e) => { if (e) finish(null); });
        });
        sock.send(Buffer.concat([RCON_PREFIX, Buffer.from('challenge rcon\n\0')]), HLTV_PORT, HLTV_HOST, (e) => { if (e) finish(null); });
    });
}

let prevBcast = null;
let prevTick = null;
const fmt = (v, w) => (v == null ? '-' : (typeof v === 'number' ? v.toFixed(1) : String(v))).padStart(w);

if (CSV) fs.writeFileSync(CSV, 'ts,online,activeTime,delay,bcastNow,sampleAgeS,lastTick,qDepth,hltvGT,clockErr,clockErrPx,step\n');
console.log(`probing ${API} server="${SERVER}" + HLTV ${HLTV} (Ctrl-C to stop)`);
console.log(['time', 'onl', 'actT', 'delay', 'bcastNow', 'ageS', 'lastTick', 'qDep', 'hltvGT', 'clockErr', 'clockErrPx', 'STEP']
    .map((h, i) => h.padStart([8, 4, 6, 5, 9, 6, 9, 5, 7, 9, 10, 5][i])).join(' '));

async function tick() {
    const ts = new Date().toTimeString().slice(0, 8);
    let s = null, rc = null;
    try {
        const j = await httpJson(`${API}/api/hltv/status`);
        s = (j.servers || []).find((x) => x.server === SERVER) || null;
    } catch (e) { /* leave s null */ }
    rc = await rconStatus();

    if (!s) { console.log(`${ts}  (server not found / backend unreachable)`); return; }

    const bcast = typeof s.broadcastNow === 'number' ? s.broadcastNow : null;
    const lastTick = s.lastEventTick ?? null;          // undefined on the pre-fix build
    const delay = s.delaySeconds ?? null;
    const ageS = s.sampleAgeMs != null ? s.sampleAgeMs / 1000 : null;
    const hltvGT = rc ? rc.gameTime : null;

    const clockErr = (bcast != null && lastTick != null && delay != null) ? bcast - (lastTick - delay) : null;
    const clockErrPx = (bcast != null && hltvGT != null && delay != null) ? bcast - (hltvGT - delay) : null;

    let step = '';
    if (prevBcast != null && bcast != null) {
        const jump = bcast - prevBcast;
        const tickReset = prevTick != null && lastTick != null && (prevTick - lastTick) > 30;
        if (Math.abs(jump) > 2 + INTERVAL / 1000 && !tickReset) step = `STEP${jump > 0 ? '+' : ''}${jump.toFixed(1)}`;
    }
    prevBcast = bcast; prevTick = lastTick;

    console.log([ts, String(s.online), fmt(s.activeTime, 6), fmt(delay, 5), fmt(bcast, 9), fmt(ageS, 6),
        fmt(lastTick, 9), fmt(s.queueDepth, 5), fmt(hltvGT, 7), fmt(clockErr, 9), fmt(clockErrPx, 10), step.padStart(5)].join(' '));
    if (CSV) fs.appendFileSync(CSV, `${Date.now()},${s.online},${s.activeTime},${delay},${bcast},${ageS},${lastTick},${s.queueDepth},${hltvGT},${clockErr},${clockErrPx},${step}\n`);
}

tick();
setInterval(tick, INTERVAL);
