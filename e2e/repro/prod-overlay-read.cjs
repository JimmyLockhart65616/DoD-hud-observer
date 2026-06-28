// PROD overlay timer reader — the "what is the live overlay showing?" tool.
//
// At one wall instant it reads, for a chosen prod server:
//   • HUD timeleft  — joins the prod Socket.IO server (http://74.91.112.242:4000)
//                     exactly like a fresh OBS browser source and captures the
//                     snapshot's age-adjusted `time_sync.timeleft`. This is the
//                     value a freshly-loaded overlay anchors to → what the HUD shows.
//   • broadcastNow / lastEventTick / delay / activeTime / calibrationOffsetMs
//                     — GET /api/hltv/status (port 3001).
//
// Prints one timestamped row + the gap-math line. The OVERLAY side is fully
// measurable from here; the SPECTATOR side (what your DoD game client renders)
// is computed inside the client and is NOT readable server-side — you must read
// it with your eyes at the same wall instant and drop it into "yourClient".
//
//   overlayLagVsLive = lastEventTick - broadcastNow      (should be ≈ delay = 60)
//   spectatorGap     = yourClientTimeleft - HUDtimeleft  (FILL IN; the real bug)
//                      >0 ⇒ your client has MORE time left ⇒ overlay is AHEAD of
//                      the footage by that many seconds.
//
// Usage:
//   node e2e/repro/prod-overlay-read.cjs ["KTP - Atlanta 1"]
//        [--api http://74.91.112.242:3001] [--socket http://74.91.112.242:4000]
//        [--interval 0]            # 0 = single shot (default); >0 = repeat every N ms
//        [--csv <scratch path>]    # append rows for a multi-sample half
const http = require('http');
const fs = require('fs');
const { io } = require('socket.io-client');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SERVER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'KTP - Atlanta 1';
const API = arg('--api', 'http://74.91.112.242:3001');
const SOCKET = arg('--socket', 'http://74.91.112.242:4000');
const INTERVAL = parseInt(arg('--interval', '0'), 10);
const CSV = arg('--csv', null);

const mmss = (s) => (s == null ? '   -' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const fmt = (v, w) => (v == null ? '-' : (typeof v === 'number' ? v.toFixed(1) : String(v))).padStart(w);

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

// Join the prod Socket.IO server like a fresh overlay; return the snapshot time_sync.timeleft.
function snapshotTimeleft() {
    return new Promise((resolve) => {
        const socket = io(SOCKET, { transports: ['websocket'], reconnection: false, timeout: 5000 });
        let tl = null;
        socket.onAny((event, raw) => {
            let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
            if (event === 'time_sync' && tl == null && e.timeleft != null) tl = e.timeleft;
        });
        socket.on('connect', () => socket.emit('join_server', SERVER));
        socket.on('connect_error', () => { try { socket.close(); } catch (_) {} resolve(null); });
        setTimeout(() => { try { socket.close(); } catch (_) {} resolve(tl); }, 2000);
    });
}

let printedHeader = false;
async function sample() {
    const ts = new Date().toTimeString().slice(0, 8);
    let s = null;
    try {
        const j = await httpJson(`${API}/api/hltv/status`);
        s = (j.servers || []).find((x) => x.server === SERVER) || null;
    } catch (_) {}
    const hud = await snapshotTimeleft();

    if (!s) { console.log(`${ts}  (server "${SERVER}" not found / backend unreachable)`); return; }
    const bcast = typeof s.broadcastNow === 'number' ? s.broadcastNow : null;
    const lastTick = s.lastEventTick ?? null;
    const delay = s.delaySeconds ?? null;
    const calib = s.calibrationOffsetMs ?? 0;
    const lag = (bcast != null && lastTick != null) ? lastTick - bcast : null; // ≈ delay if healthy

    if (!printedHeader) {
        console.log(`server="${SERVER}"  api=${API}  socket=${SOCKET}`);
        console.log(['time', 'map', 'HUD(m:ss)', 'tl(s)', 'bcastNow', 'lastTick', 'delay', 'lag', 'calibMs', 'yourClient']
            .map((h, i) => h.padStart([8, 16, 9, 6, 9, 9, 6, 6, 8, 11][i])).join(' '));
        printedHeader = true;
    }
    console.log([ts, String(s.map ?? '-').padStart(16), mmss(hud).padStart(9), fmt(hud, 6), fmt(bcast, 9),
        fmt(lastTick, 9), fmt(delay, 6), fmt(lag, 6), fmt(calib, 8), '   _:__ ___'].join(' '));
    if (CSV) {
        if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, 'wallMs,server,map,hudTimeleft,broadcastNow,lastEventTick,delay,lagVsLive,calibMs,yourClientTimeleft\n');
        fs.appendFileSync(CSV, `${Date.now()},${SERVER},${s.map},${hud},${bcast},${lastTick},${delay},${lag},${calib},\n`);
    }
    return { hud, lag };
}

(async () => {
    const r = await sample();
    if (INTERVAL > 0) { setInterval(sample, INTERVAL); }
    else {
        console.log('');
        console.log(`overlay lag vs live  = lastTick − bcastNow = ${r && r.lag != null ? r.lag.toFixed(1) : '?'}s  (healthy ≈ ${'delay'} 60)`);
        console.log(`spectator gap (BUG)  = yourClientTimeleft − HUD(${r ? r.hud : '?'}s).  Read your DoD client clock NOW and subtract.`);
        console.log(`  >0 ⇒ overlay is AHEAD of the footage by that many seconds.`);
        process.exit(0);
    }
})();
