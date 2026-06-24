// Snapshot timer/prone probe — the direct BUG-vs-FIX evidence for the
// steady-state timer fix (and the prone receipt-anchor).
//
// Joins the backend Socket.IO server exactly like a fresh OBS browser source,
// captures the snapshot's replayed `time_sync.timeleft` (and any prone
// roster_player rows), waits --gap ms, then joins AGAIN and captures a second
// time. The two captures reveal the fix:
//
//   BUG build: the snapshot replays the cached timeleft VERBATIM, so it does NOT
//              decrease as wall time passes — delta ≈ 0. A fresh tab anchors a
//              stale value and the clock is wrong by the cache age.
//   FIX build: the snapshot is AGE-ADJUSTED, so the second capture is lower by
//              ~the elapsed gap — delta ≈ −gap. A fresh tab is delay-aligned.
//
// Usage:
//   node e2e/repro/snapshot-probe.cjs ["KTP Local Dev #1"] [--url http://localhost:4000] [--gap 12000]
const { io } = require('socket.io-client');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SERVER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'KTP Local Dev #1';
const URL = arg('--url', 'http://localhost:4000');
const GAP = parseInt(arg('--gap', '12000'), 10);

function capture() {
    return new Promise((resolve) => {
        const socket = io(URL, { transports: ['websocket'], reconnection: false, timeout: 4000 });
        const out = { timeleft: null, prone: [], at: Date.now() };
        socket.onAny((event, raw) => {
            let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
            if (event === 'time_sync' && out.timeleft == null) out.timeleft = e.timeleft;
            if (event === 'roster_player' && e.prone_state && e.prone_state !== 'standing') {
                out.prone.push({ id: e.user_id, prone_since: e.prone_since });
            }
        });
        socket.on('connect', () => socket.emit('join_server', SERVER));
        setTimeout(() => { try { socket.close(); } catch (_) {} resolve(out); }, 1500);
    });
}

(async () => {
    console.log(`joining ${URL} as server="${SERVER}"`);
    const a = await capture();
    console.log(`capture #1: timeleft=${a.timeleft}  prone=${JSON.stringify(a.prone)}`);
    if (GAP > 0) {
        await new Promise((r) => setTimeout(r, GAP));
        const b = await capture();
        const dt = (b.at - a.at) / 1000;
        console.log(`capture #2 (+${dt.toFixed(1)}s): timeleft=${b.timeleft}  prone=${JSON.stringify(b.prone)}`);
        if (a.timeleft != null && b.timeleft != null) {
            const delta = b.timeleft - a.timeleft;
            console.log(`\ntimeleft delta = ${delta}s over ${dt.toFixed(1)}s wall`);
            if (Math.abs(delta) < 2) console.log('→ STALE (BUG): snapshot timer did not advance — fresh tabs anchor a stale value');
            else if (Math.abs(delta + dt) < 3) console.log('→ AGE-ADJUSTED (FIX): snapshot timer tracks the broadcast clock');
            else console.log(`→ delta ${delta} vs expected ~${(-dt).toFixed(1)} (inspect)`);
        }
    }
    process.exit(0);
})();
