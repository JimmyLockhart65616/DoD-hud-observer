// End-to-end broadcast-alignment probe — machine-only, no DoD client, no relay.
//
// THE QUESTION: when the overlay shows an event, is the viewer seeing that same
// moment in the video? Every earlier attempt answered this indirectly — the
// relay understated the serve point by a full hop, and the two HUD clocks turned
// out not to be comparable quantities. This measures it directly.
//
// THE METHOD: the KTP `Spectator Time` patch exposes Proxy::GetSpectatorTime()
// (m_ClientWorldTime) — the game time HLTV is serving to viewers RIGHT NOW. That
// is the footage side, machine-readable. So for an event stamped with game tick
// T that reaches the overlay at wall instant W:
//
//     overlayLag = SpectatorTime(W) - T
//
//        0   the overlay fires exactly as the broadcast reaches that frame
//      > 0   the overlay is BEHIND the video (the caster's reported symptom)
//      < 0   the overlay is AHEAD of the video (spoils the feed)
//
// SpectatorTime(W) is projected from periodic rcon anchors (see below).
// Projection is sound because the serve clock advances 1:1 with wall time —
// measured flat at 60.02s +/- 0.01 against `Delay 60` over a 4-minute soak. New
// anchors are picked up continuously, so a clock reset shows up as a step rather
// than silently biasing the series.
//
// Both sides are independent of `Delay` and of the MM:SS `Game Time` field, so
// this number is immune to the truncation bias that distorts broadcastNow.
//
// Anchors come from rcon `status` — a synchronous round trip, so the wall
// instant is known to within the round trip itself (~10-50ms on loopback)
// rather than the seconds of slop a log-scraping sampler carries.
//
// Usage:
//   node e2e/repro/local-e2e-align.cjs ["KTP Local Dev #1"]
//        [--socket http://localhost:4000]
//        [--hltv 127.0.0.1:27020] [--hltv-pw localdev-rcon]
//        [--anchor-interval 10000] [--csv out.csv] [--quiet]
'use strict';
const fs = require('fs');
const { rconCommand, splitHostPort } = require('./lib/rcon.cjs');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SERVER   = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'KTP Local Dev #1';
const SOCKET   = arg('--socket', 'http://localhost:4000');
const [HLTV_HOST, HLTV_PORT] = splitHostPort(arg('--hltv', '127.0.0.1:27020'));
const HLTV_PW  = arg('--hltv-pw', 'localdev-rcon');
const ANCHOR_MS = +arg('--anchor-interval', '10000');
const CSV      = arg('--csv', '');
const QUIET    = process.argv.includes('--quiet');

let io;
try { io = require('socket.io-client').io; }
catch { console.error('need socket.io-client (npm i, or run from the repo root)'); process.exit(1); }

// ─── serve-clock anchors ────────────────────────────────────────────────────
// Keep the last few so a single bad read can't skew projection; use the newest
// valid one. Anchor age is reported per row — a large age means the sampler
// stalled and the row deserves less trust.
let anchors = [];

async function refreshAnchors() {
    const before = Date.now();
    let text;
    try { text = await rconCommand(HLTV_HOST, HLTV_PORT, HLTV_PW, 'status', 5000); }
    catch { return; }
    const after = Date.now();
    if (!text) return;

    const m = text.match(/Spectator Time ([0-9.]+), World Time ([0-9.]+)/);
    if (!m) {
        // Older proxy.so without the KTP serve-clock patch. Refuse to guess:
        // deriving the serve point from (Game Time - Delay) reintroduces both
        // the MM:SS truncation and the assumption this probe exists to test.
        if (!refreshAnchors.warned) {
            console.log('!! status has no `Spectator Time` — this proxy lacks the serve-clock patch; cannot measure');
            refreshAnchors.warned = true;
        }
        return;
    }
    const d = text.match(/Delay (\d+)/);
    // Midpoint of the round trip: the reply was generated somewhere inside it.
    anchors.push({ wallMs: (before + after) / 2, serve: +m[1], world: +m[2],
                   delay: d ? +d[1] : null, rttMs: after - before });
    if (anchors.length > 8) anchors.shift();
}

// Game time being served at wall instant `wallMs`, projected off the newest
// anchor at or before it (else the oldest we have).
function serveTimeAt(wallMs) {
    if (!anchors.length) return null;
    let a = anchors[anchors.length - 1];
    for (let i = anchors.length - 1; i >= 0; i--) {
        if (anchors[i].wallMs <= wallMs) { a = anchors[i]; break; }
    }
    return { serve: a.serve + (wallMs - a.wallMs) / 1000, anchorAgeMs: wallMs - a.wallMs, delay: a.delay };
}

refreshAnchors();
setInterval(refreshAnchors, ANCHOR_MS);

// ─── overlay side ───────────────────────────────────────────────────────────
// A persistent connection, exactly like an OBS browser source: events are
// timestamped at ARRIVAL, which is the instant the overlay would render them.
const out = CSV ? fs.createWriteStream(CSV, { flags: 'a' }) : null;
if (out) out.write('wallMs,iso,event,tick,serveTime,overlayLag,anchorAgeMs,delay\n');

let n = 0, sum = 0, min = Infinity, max = -Infinity;

const socket = io(SOCKET, { transports: ['websocket'], reconnection: true });
socket.on('connect', () => {
    console.log(`connected ${SOCKET} — join_server ${JSON.stringify(SERVER)}`);
    socket.emit('join_server', SERVER);
});
socket.on('connect_error', e => console.log(`connect_error: ${e.message}`));

socket.onAny((name, raw) => {
    const arrived = Date.now();
    let e;
    try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!e || typeof e.tick !== 'number') return;      // untick'd events can't be aligned

    const s = serveTimeAt(arrived);
    if (!s) return;                                     // no anchor yet

    const lag = s.serve - e.tick;
    n++; sum += lag;
    if (lag < min) min = lag;
    if (lag > max) max = lag;

    if (!QUIET) {
        console.log(
            `${new Date(arrived).toISOString().slice(11, 23)}  ${String(name).padEnd(22)}` +
            ` tick=${e.tick.toFixed(2).padStart(9)}  serve=${s.serve.toFixed(2).padStart(9)}` +
            `  overlayLag=${lag >= 0 ? '+' : ''}${lag.toFixed(2).padStart(7)}s` +
            (s.anchorAgeMs > 30000 ? `  (stale anchor ${(s.anchorAgeMs / 1000) | 0}s)` : '')
        );
    }
    if (out) {
        out.write(`${arrived},${new Date(arrived).toISOString()},${name},${e.tick},` +
                  `${s.serve.toFixed(3)},${lag.toFixed(3)},${s.anchorAgeMs},${s.delay ?? ''}\n`);
    }
});

function summary() {
    if (!n) { console.log('\n(no aligned events yet)'); return; }
    console.log(`\n── ${n} events │ overlayLag mean ${(sum / n).toFixed(2)}s ` +
                `│ min ${min.toFixed(2)}s │ max ${max.toFixed(2)}s`);
    console.log('   >0 = overlay behind the video, <0 = overlay ahead (spoiler)');
}
process.on('SIGINT', () => { summary(); process.exit(0); });
setInterval(summary, 60000);
