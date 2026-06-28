// Persistent-overlay timer DRIFT probe — the instrument for "does the frontend
// timer drift from the HLTV source of truth over time?"
//
// Unlike segment-probe (which fresh-joins each sample and therefore always
// re-anchors to a correct value), this holds ONE long-lived socket connection
// exactly like a real OBS browser source, and replicates the frontend's timer
// math faithfully:
//   • Socket.jsx setTimeleft:   on time_sync / round_start / half_start carrying
//     `timeleft`, anchor (timeleft, timeleft_at = Date.now()).      [Socket.jsx:210]
//   • Timer.jsx countdown:      displayed = timeleft − floor((Date.now()−timeleft_at)/1000).
//                                                                    [Timer.jsx:14-38]
//
// What it catches that the fresh-join probes can't:
//   DRIFT A  — on each NEW time_sync, BEFORE re-anchoring, record the prediction
//              error of the local countdown:
//                 predicted = anchorTimeleft − (arrival − anchorAt)/1000
//                 driftA    = predicted − newTimeleft
//              i.e. how far the locally-counted timer had wandered from the
//              authoritative game clock over the last window. Nonzero/growing =
//              setInterval/clock-rate drift, late buffer release, or skew.
//   WEDGE    — time_sync inter-arrival gap. Healthy ~30s; a gap ≫30s means the
//              re-anchor stopped (half-1 task wedge / DODX forward silence) and a
//              persistent overlay is now coasting blind — drift accumulates
//              UNCORRECTED until the next anchor (or forever).
//   DRIFT B  — optional: vs a relay's served Game Time (the footage). Needs the
//              half length to convert; pass --half-seconds if known.
//
// It also samples the displayed timer every --interval ms so you can watch it live.
//
// Usage:
//   node e2e/repro/overlay-drift-probe.cjs ["KTP Local Dev #1"]
//        [--socket http://localhost:4000] [--interval 5000] [--csv <path>]
//        [--wedge-seconds 35]
'use strict';
const fs = require('fs');
const { io } = require('socket.io-client');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SERVER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'KTP Local Dev #1';
const SOCKET = arg('--socket', 'http://localhost:4000');
const INTERVAL = parseInt(arg('--interval', '5000'), 10);
const WEDGE_S = parseFloat(arg('--wedge-seconds', '35'));
const CSV = arg('--csv', null);

// ── frontend state (mirrors the Zustand store) ───────────────────────────────
let anchorTimeleft = null;     // store.timeleft
let anchorAt = null;           // store.timeleft_at (Date.now at receipt)
let lastSyncAt = null;         // wall time of the last time_sync (cadence/wedge)
let syncCount = 0;

const nowS = () => Date.now() / 1000;
// Timer.jsx displayed value at this instant.
function displayed() {
    if (anchorTimeleft == null || anchorAt == null) return null;
    return Math.max(0, anchorTimeleft - Math.floor((Date.now() - anchorAt) / 1000));
}
const fmt = (v, w) => (v == null ? '-' : typeof v === 'number' ? v.toFixed(1) : String(v)).padStart(w);
const mmss = (s) => (s == null ? '-' : `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`);

if (CSV) fs.writeFileSync(CSV, 'wallMs,event,displayedBefore,newTimeleft,driftA,syncGapS,sinceSyncS\n');
function logCsv(event, displayedBefore, newTimeleft, driftA, syncGap, sinceSync) {
    if (!CSV) return;
    fs.appendFileSync(CSV, `${Date.now()},${event},${displayedBefore ?? ''},${newTimeleft ?? ''},${driftA ?? ''},${syncGap ?? ''},${sinceSync ?? ''}\n`);
}

// Apply an anchor-carrying event exactly like Socket.jsx, measuring drift first.
function onAnchorEvent(kind, timeleft) {
    if (timeleft == null) return;
    const arrival = Date.now();
    // prediction error of the local countdown over the window just ended
    let driftA = null, predicted = null, syncGap = null;
    if (anchorTimeleft != null && anchorAt != null) {
        predicted = anchorTimeleft - (arrival - anchorAt) / 1000;
        driftA = predicted - timeleft;
    }
    if (kind === 'time_sync') {
        if (lastSyncAt != null) syncGap = (arrival - lastSyncAt) / 1000;
        lastSyncAt = arrival;
        syncCount++;
    }
    const ts = new Date().toTimeString().slice(0, 8);
    const wedge = syncGap != null && syncGap > WEDGE_S ? `  <-- WEDGE gap ${syncGap.toFixed(0)}s` : '';
    const driftFlag = driftA != null && Math.abs(driftA) > 2 ? `  <-- DRIFT ${driftA > 0 ? '+' : ''}${driftA.toFixed(1)}s` : '';
    console.log(`${ts}  ${kind.padEnd(12)} timeleft=${mmss(timeleft)}  predicted=${predicted != null ? predicted.toFixed(1) : '-'}  driftA=${driftA != null ? driftA.toFixed(1) : '-'}  syncGap=${syncGap != null ? syncGap.toFixed(0) + 's' : '-'}${wedge}${driftFlag}`);
    logCsv(kind, predicted != null ? predicted.toFixed(1) : '', timeleft, driftA != null ? driftA.toFixed(2) : '', syncGap != null ? syncGap.toFixed(1) : '', null);
    // re-anchor (store update)
    anchorTimeleft = timeleft;
    anchorAt = arrival;
}

const socket = io(SOCKET, { transports: ['websocket'], reconnection: true });
socket.on('connect', () => { console.log(`connected ${SOCKET}, join_server "${SERVER}"`); socket.emit('join_server', SERVER); });
socket.on('connect_error', (e) => console.log(`connect_error: ${e.message}`));
socket.onAny((event, raw) => {
    if (event !== 'time_sync' && event !== 'round_start' && event !== 'half_start') return;
    let e; try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
    if (e && e.timeleft != null) onAnchorEvent(event, e.timeleft);
});

// periodic "what is the persistent overlay showing right now" + wedge watch
setInterval(() => {
    const sinceSync = lastSyncAt != null ? (Date.now() - lastSyncAt) / 1000 : null;
    const ts = new Date().toTimeString().slice(0, 8);
    const wedge = sinceSync != null && sinceSync > WEDGE_S ? `  <-- NO time_sync for ${sinceSync.toFixed(0)}s (coasting blind)` : '';
    console.log(`${ts}  [tick]       displayed=${mmss(displayed())}  sinceSync=${sinceSync != null ? sinceSync.toFixed(0) + 's' : '-'}  syncs=${syncCount}${wedge}`);
    if (CSV) fs.appendFileSync(CSV, `${Date.now()},tick,${displayed() ?? ''},,,,${sinceSync != null ? sinceSync.toFixed(1) : ''}\n`);
}, INTERVAL);

console.log(`persistent-overlay drift probe: server="${SERVER}" interval=${INTERVAL}ms wedge>${WEDGE_S}s (Ctrl-C to stop)`);
