#!/usr/bin/env node
/*
 * cap-break-replay.cjs — offline forensic replay of the plugin's cap-break
 * arm/confirm state machine against a recorded prod events.jsonl[.gz].
 *
 * Why: cap_break fires ~1 per 2700 kills in prod (10 events / 39 matches) while
 * kills-on-point are routine. This replays the exact detection gates from
 * KTPHudObserver.sma (ARM in client_death L1114-1133, CONFIRM in task_poll_zones
 * L1458-1478) using the stream's own flag_zone_players samples — the very pdata
 * values the plugin read, at the same 0.5s poll cadence — to measure WHERE the
 * misses happen:
 *
 *   - How often is a qualifying kill (cross-team, victim's team capping per the
 *     last poll — the ARM precondition) followed by an in-zone count drop at the
 *     NEXT poll (the plugin's one-shot confirm window)? If often, the plugin
 *     should have confirmed those — the only unobservable difference is its
 *     arm-time FRESH pdata read between polls, so a large "expected@1" with
 *     ~zero actual cap_breaks proves (by elimination) the fresh read already
 *     saw the decrement (H1a).
 *   - Latency histogram: first count-drop poll after each qualifying kill
 *     (1 = next poll). Mass at 2+ polls = decrement lags the one-shot window (H1b).
 *   - Drops correlating with the victim's respawn = body counted until respawn
 *     (H1b strong).
 *   - Masking: teammate entering the zone in the window hides the drop (H1c).
 *
 * RESIDUAL AMBIGUITY: the stream cannot show the plugin's between-poll fresh
 * arm read. A dominant "expected@1" bucket implicates H1a only by elimination;
 * the CAP_BREAK_DIAG instrumented build (Stage 3) proves it directly.
 *
 * Usage: node e2e/repro/cap-break-replay.cjs <events.jsonl[.gz]> [--csv <out.csv>]
 */

'use strict';

const fs = require('fs');
const zlib = require('zlib');

const MAX_WINDOW_POLLS = 20;     // forward scan bound per qualifying kill
const RESPAWN_SLOP_S = 0.6;      // drop within this of victim respawn => respawn-correlated
const SEGMENT_TICK_JUMP = 60;    // tick going backwards by more than this = new map segment

function loadEvents(path) {
    let buf = fs.readFileSync(path);
    if (path.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    const events = [];
    for (const line of buf.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { events.push(JSON.parse(t)); } catch { /* torn tail line */ }
    }
    return events;
}

function main() {
    const args = process.argv.slice(2);
    const csvIdx = args.indexOf('--csv');
    const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : null;
    const inputs = args.filter((a, i) => a !== '--csv' && i !== csvIdx + 1);
    if (inputs.length !== 1) {
        console.error('usage: node cap-break-replay.cjs <events.jsonl[.gz]> [--csv out.csv]');
        process.exit(1);
    }

    const events = loadEvents(inputs[0]);

    // ── Pass 1: segment the stream (tick resets on map reload between halves) ──
    // A segment is a contiguous run where tick is monotonic-ish. All per-flag
    // state (capping, zone series) is segment-scoped, like the plugin's own
    // state across changelevel.
    let seg = 0;
    let lastTick = -Infinity;
    for (const ev of events) {
        const tick = typeof ev.tick === 'number' ? ev.tick : lastTick;
        if (tick < lastTick - SEGMENT_TICK_JUMP) seg++;
        ev._seg = seg;
        lastTick = tick;
    }

    // ── Pass 2: replay state, collect series ──
    const teams = new Map();          // user_id -> 'allies'|'axis' (latest known)
    const capping = new Map();        // `${seg}:${flag_id}` -> {team, sinceTick}
    const zoneSeries = new Map();     // `${seg}:${flag_id}` -> [{tick, allies, axis}]
    const numcapByFlag = new Map();   // `${seg}:${flag_id}` -> {allies, axis}
    const flagNames = new Map();      // flag_id -> name (last flags_init wins)
    const spawnsByUser = new Map();   // user_id -> [ticks] (segment-agnostic; tick+seg pairs)
    const capStops = [];              // {seg, tick, flag_id}
    const capStartedCount = { n: 0 };
    const capturedCount = { n: 0 };
    const actualBreaks = [];          // cap_break events {seg, tick, flag_id, breaker_id, broke_team}
    const qualifyingKills = [];       // ARM-eligible kills

    const kf = (s, f) => `${s}:${f}`;

    for (const ev of events) {
        const s = ev._seg;
        switch (ev.event) {
            case 'player_connect':
            case 'player_team_change':
            case 'player_spawn':
                if (ev.user_id && (ev.team === 'allies' || ev.team === 'axis')) teams.set(ev.user_id, ev.team);
                if (ev.event === 'player_spawn' && ev.user_id) {
                    if (!spawnsByUser.has(ev.user_id)) spawnsByUser.set(ev.user_id, []);
                    spawnsByUser.get(ev.user_id).push({ seg: s, tick: ev.tick });
                }
                break;
            case 'flags_init':
                if (Array.isArray(ev.flags)) for (const fl of ev.flags) flagNames.set(fl.flag_id, fl.flag_name);
                break;
            case 'flag_zone_players':
                if (Array.isArray(ev.zones)) for (const z of ev.zones) {
                    const key = kf(s, z.flag_id);
                    if (!zoneSeries.has(key)) zoneSeries.set(key, []);
                    zoneSeries.get(key).push({ tick: ev.tick, allies: z.allies_count, axis: z.axis_count });
                    numcapByFlag.set(key, { allies: z.allies_numcap, axis: z.axis_numcap });
                }
                break;
            case 'flag_cap_started':
                capStartedCount.n++;
                capping.set(kf(s, ev.flag_id), { team: ev.capping_team, sinceTick: ev.tick });
                break;
            case 'flag_cap_stopped':
                capStops.push({ seg: s, tick: ev.tick, flag_id: ev.flag_id });
                capping.delete(kf(s, ev.flag_id));
                break;
            case 'flag_captured':
                capturedCount.n++;
                capping.delete(kf(s, ev.flag_id));
                break;
            case 'cap_break':
                actualBreaks.push({ seg: s, tick: ev.tick, flag_id: ev.flag_id, breaker_id: ev.breaker_id, broke_team: ev.broke_team });
                break;
            case 'kill': {
                // Mirror the ARM gate: killer!=victim && !TK  ⇔  kill_type "normal";
                // victim's (plugin-tracked) team must match a flag's capping team as
                // of the last poll. First matching flag only, like the plugin.
                if (ev.kill_type !== 'normal') break;
                const vt = teams.get(ev.victim_id);
                if (vt !== 'allies' && vt !== 'axis') break;
                for (const [key, cap] of capping) {
                    const [cseg, cflag] = key.split(':').map(Number);
                    if (cseg !== s || cap.team !== vt) continue;
                    qualifyingKills.push({
                        seg: s, tick: ev.tick, flag_id: cflag, victim_id: ev.victim_id,
                        killer_id: ev.killer_id, team: vt, capSinceTick: cap.sinceTick,
                    });
                    break;
                }
                break;
            }
        }
    }

    // ── Pass 3: join each qualifying kill against its flag's zone-count series ──
    const rows = [];
    for (const q of qualifyingKills) {
        const series = zoneSeries.get(kf(q.seg, q.flag_id)) || [];
        // last poll at or before the kill = the plugin's view when it armed
        let preIdx = -1;
        for (let i = 0; i < series.length; i++) {
            if (series[i].tick <= q.tick) preIdx = i; else break;
        }
        const pre = preIdx >= 0 ? series[preIdx] : null;
        const was = pre ? pre[q.team] : null;

        let latencyPolls = null;   // 1 = drop visible at the very next poll (the one-shot window)
        let dropTick = null;
        let maskedAtPoll1 = false;
        if (pre && was > 0) {
            for (let i = preIdx + 1; i < series.length && i <= preIdx + MAX_WINDOW_POLLS; i++) {
                const now = series[i][q.team];
                if (now < was) { latencyPolls = i - preIdx; dropTick = series[i].tick; break; }
                if (i === preIdx + 1 && now >= was) maskedAtPoll1 = true;
            }
        }

        // respawn correlation: victim's next spawn in this segment
        let respawnCorrelated = false;
        let respawnTick = null;
        const spawns = spawnsByUser.get(q.victim_id) || [];
        for (const sp of spawns) {
            if (sp.seg === q.seg && sp.tick > q.tick) { respawnTick = sp.tick; break; }
        }
        if (dropTick !== null && respawnTick !== null) {
            respawnCorrelated = Math.abs(dropTick - respawnTick) <= RESPAWN_SLOP_S;
        }

        // independent decrement proxy: kill -> next flag_cap_stopped on this flag
        let capstopLatency = null;
        for (const st of capStops) {
            if (st.seg === q.seg && st.flag_id === q.flag_id && st.tick >= q.tick) {
                capstopLatency = +(st.tick - q.tick).toFixed(2); break;
            }
        }

        // did the plugin actually credit this one?
        const credited = actualBreaks.some(b =>
            b.seg === q.seg && b.flag_id === q.flag_id && b.tick >= q.tick && b.tick <= q.tick + 1.5);

        rows.push({
            seg: q.seg, tick: q.tick, flag_id: q.flag_id,
            flag_name: flagNames.get(q.flag_id) || '?',
            team: q.team, victim_id: q.victim_id, killer_id: q.killer_id,
            capAgeS: +(q.tick - q.capSinceTick).toFixed(2),
            was, latencyPolls, dropTick, maskedAtPoll1, respawnCorrelated,
            respawnDeltaS: (dropTick !== null && respawnTick !== null) ? +(dropTick - respawnTick).toFixed(2) : null,
            capstopLatency, credited,
        });
    }

    // ── Report ──
    const total = rows.length;
    const withZeroCount = rows.filter(r => r.was === 0 || r.was === null).length;
    const hist = {};
    for (const r of rows) {
        const b = r.was === null || r.was === 0 ? 'no-zone-count' : (r.latencyPolls === null ? 'never-dropped' : String(r.latencyPolls));
        hist[b] = (hist[b] || 0) + 1;
    }
    const cum = [];
    for (let n = 1; n <= 10; n++) {
        cum.push({ window: n, expectedBreaks: rows.filter(r => r.latencyPolls !== null && r.latencyPolls <= n).length });
    }

    console.log(`=== cap-break forensic replay: ${inputs[0]} ===`);
    console.log(`events: ${events.length}, segments: ${seg + 1}`);
    console.log(`flag_cap_started observed by poll: ${capStartedCount.n}   flag_captured: ${capturedCount.n}` +
        `   (captured without observed cap window: ${Math.max(0, capturedCount.n - capStartedCount.n)} — sub-poll caps)`);
    console.log(`actual cap_break events in stream: ${actualBreaks.length}`);
    console.log(`\nARM-eligible (qualifying) kills: ${total}` +
        `   [victim's team capping per last poll, kill_type normal]`);
    console.log(`  of which zone count for capping team was 0/absent at last pre-kill poll: ${withZeroCount}` +
        ` (victim not on point, or count already drained)`);
    console.log(`\nLatency histogram (first count-drop poll after kill; 1 = plugin's one-shot window):`);
    for (const k of Object.keys(hist).sort((a, b) => (parseInt(a) || 99) - (parseInt(b) || 99))) {
        console.log(`  ${k.padStart(14)}: ${hist[k]}`);
    }
    console.log(`\nExpected confirmed breaks by window size (vs ${rows.filter(r => r.credited).length} actually credited):`);
    for (const c of cum) console.log(`  window ${c.window} poll(s): ${c.expectedBreaks}`);
    console.log(`\nmasked at poll 1 (count held/rose then dropped later): ${rows.filter(r => r.maskedAtPoll1 && r.latencyPolls !== null).length}`);
    console.log(`drop respawn-correlated (±${RESPAWN_SLOP_S}s of victim respawn): ${rows.filter(r => r.respawnCorrelated).length}`);

    const capstops = rows.filter(r => r.capstopLatency !== null && r.capstopLatency <= 10);
    if (capstops.length) {
        const lats = capstops.map(r => r.capstopLatency).sort((a, b) => a - b);
        const p = q => lats[Math.min(lats.length - 1, Math.floor(q * lats.length))];
        console.log(`kill -> flag_cap_stopped latency (<=10s, n=${lats.length}): p50=${p(0.5)}s p90=${p(0.9)}s max=${lats[lats.length - 1]}s`);
    }

    const credited = rows.filter(r => r.credited);
    if (credited.length) {
        console.log(`\nCredited breaks back-joined (${credited.length}):`);
        for (const r of credited) {
            console.log(`  seg${r.seg} tick=${r.tick} ${r.flag_name} team=${r.team} was=${r.was} latency=${r.latencyPolls} capAge=${r.capAgeS}s`);
        }
    }

    const perFlag = {};
    for (const r of rows) {
        const key = `${r.flag_id}:${r.flag_name}`;
        perFlag[key] = perFlag[key] || { kills: 0, drops1: 0, credited: 0 };
        perFlag[key].kills++;
        if (r.latencyPolls === 1) perFlag[key].drops1++;
        if (r.credited) perFlag[key].credited++;
    }
    console.log(`\nPer-flag qualifying kills / next-poll drops / credited:`);
    for (const [k, v] of Object.entries(perFlag)) console.log(`  ${k}: ${v.kills} / ${v.drops1} / ${v.credited}`);

    if (csvPath) {
        const cols = ['seg', 'tick', 'flag_id', 'flag_name', 'team', 'victim_id', 'killer_id', 'capAgeS', 'was',
            'latencyPolls', 'dropTick', 'maskedAtPoll1', 'respawnCorrelated', 'respawnDeltaS', 'capstopLatency', 'credited'];
        const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => r[c] === null ? '' : r[c]).join(','))).join('\n');
        fs.writeFileSync(csvPath, csv + '\n');
        console.log(`\nper-kill CSV written: ${csvPath} (${rows.length} rows)`);
    }
}

main();
