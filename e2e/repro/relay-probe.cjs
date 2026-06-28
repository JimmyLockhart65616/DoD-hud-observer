// Chained-relay broadcast-point probe — machine-measures the HLTV master's true
// SERVE delay to a fresh joiner, removing the human from the most important
// measurement. (Pairs with relay-launch.sh, which spins the throwaway relay.)
//
// A delay-0 relay re-broadcasts whatever frames it receives from the master, so
// its rcon "Game Time" = the master's broadcast serve point. With the master's
// own rcon Game Time (= live):
//   proxySrvDelay = masterGameTime − relayGameTime   (the master's serve-delay)
//
// Three tests this drives (see SYNC-MEASUREMENT.md):
//   • join-dependence — watch one relay's proxySrvDelay from connect+0 onward.
//     Flat ⇒ a constant serve point; growing ⇒ deep-buffer-join behavior.
//   • multi-viewer — pass several --relay (joined at staggered times). Identical
//     Game Time across them = per-proxy-uniform (ReHLDS shared m_ClientWorldTime);
//     divergence = join-dependent. Answers "is the delay the same for all viewers?"
//   • across-changelevel — keep relays connected through a half boundary; a jump
//     in proxySrvDelay at the changelevel ⇒ a baked constant can't survive halftime.
//
// Usage:
//   node e2e/repro/relay-probe.cjs --master 127.0.0.1:27020 --master-pw <pw>
//        --relay 127.0.0.1:27060 [--relay 127.0.0.1:27061 ...] --relay-pw <pw>
//        [--interval 2000] [--csv <path>]
// (--relay repeats; all relays share --relay-pw. Passwords are never printed.)
'use strict';
const fs = require('fs');
const { rconHltvStatus, splitHostPort } = require('./lib/rcon.cjs');
const M = require('./lib/sync-math.cjs');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function argAll(name) {
    const out = [];
    for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === name) out.push(process.argv[i + 1]);
    return out;
}
const MASTER = arg('--master', null);
const MASTER_PW = arg('--master-pw', null);
const RELAYS = argAll('--relay');
const RELAY_PW = arg('--relay-pw', null);
const INTERVAL = parseInt(arg('--interval', '2000'), 10);
const CSV = arg('--csv', null);
const RCON_TIMEOUT = 4000;

if (!MASTER || !MASTER_PW || RELAYS.length === 0 || !RELAY_PW) {
    console.error('usage: node relay-probe.cjs --master host:port --master-pw <pw> --relay host:port [--relay ...] --relay-pw <pw> [--interval ms] [--csv path]');
    process.exit(2);
}

const fmt = (v, w) => (v == null ? '-' : typeof v === 'number' ? v.toFixed(1) : String(v)).padStart(w);
let startMs = null, prevSrv = {}, printedHeader = false;

async function tick() {
    const ts = new Date().toTimeString().slice(0, 8);
    if (startMs == null) startMs = Date.now();
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);

    const master = await rconHltvStatus(...splitHostPort(MASTER), MASTER_PW, RCON_TIMEOUT);
    const relays = await Promise.all(RELAYS.map((r) => rconHltvStatus(...splitHostPort(r), RELAY_PW, RCON_TIMEOUT)));
    const liveGT = master && !master.error ? master.gameTime : null;

    if (!printedHeader) {
        console.log(`master=${MASTER} pw=*** (Game Time = live)   relays=${RELAYS.length} pw=***   interval=${INTERVAL}ms`);
        const cols = ['time', 'sinceJoin', 'liveGT'];
        RELAYS.forEach((r, i) => cols.push(`r${i}:GT`, `r${i}:srvDel`, `r${i}:jump`));
        console.log(cols.map((h) => h.padStart(10)).join(' '));
        printedHeader = true;
    }

    const row = [ts.padStart(10), `${elapsed}s`.padStart(10), fmt(liveGT, 10)];
    const csvVals = [Date.now(), elapsed, MASTER, liveGT];
    relays.forEach((rc, i) => {
        const gt = rc && !rc.error ? rc.gameTime : null;
        const srv = M.proxySrvDelay(liveGT, gt);
        const jump = srv != null && prevSrv[i] != null ? srv - prevSrv[i] : null;
        if (srv != null) prevSrv[i] = srv;
        const jumpStr = jump != null && Math.abs(jump) > 2 + INTERVAL / 1000 ? `${jump > 0 ? '+' : ''}${jump.toFixed(1)}` : '';
        row.push(fmt(gt, 10), fmt(srv, 10), jumpStr.padStart(10));
        csvVals.push(RELAYS[i], gt, srv, rc && rc.error ? rc.error : '');
    });
    console.log(row.join(' '));

    if (CSV) {
        if (!fs.existsSync(CSV)) {
            const hdr = ['wallMs', 'sinceJoinS', 'master', 'liveGameTime'];
            RELAYS.forEach((_, i) => hdr.push(`relay${i}`, `relay${i}GameTime`, `relay${i}SrvDelay`, `relay${i}Err`));
            fs.writeFileSync(CSV, hdr.join(',') + '\n');
        }
        fs.appendFileSync(CSV, csvVals.join(',') + '\n');
    }
}

tick();
setInterval(tick, INTERVAL);
