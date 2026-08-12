#!/usr/bin/env node
/*
 * score-tick-analyze.cjs — offline analysis of DoD's territorial scoring ticks
 * against a recorded events.jsonl[.gz].
 *
 * THIS IS THE SECOND-MAP VALIDATION GATE for the scoring-tick panel.
 *
 * Why it exists: the award model — award[team] = W * count(control points held
 * by team whose default_owner != team) — was fitted to exactly ONE recorded
 * match (dod_thunder2). The countdown half of the feature is a pure observation
 * and is trustworthy anywhere; the projected-points half is a model, and a model
 * fitted to one map is a hypothesis. Before the numbers are trusted on air on a
 * given map, record a match there and run this.
 *
 * PASS criteria (all four):
 *   - a single integer W across BOTH teams for the whole match
 *   - zero model mismatches on non-cap-contaminated ticks
 *   - period stable within each phase run (±0.05s)
 *   - W agrees between the two halves
 *
 * If W differs PER MAP that is fine — the plugin learns it online per map load.
 * If W differs PER FLAG the global-W model is dead for that map; the plugin's
 * exact-division/cross-team check will already have latched the numbers off
 * there, and the durable fix is CControlPoint::m_iPointValue, which is blocked
 * behind the one-int pd_dcp correction (docs/dodx-cp-index-space-findings.md).
 *
 * Default owners are REQUIRED for the award analysis and CANNOT be recovered
 * from most recorded streams: flags_init carries only live ownership, and at map
 * load that reads neutral for every flag because of the same pd_dcp
 * misalignment. Pass them explicitly. The live plugin reads them from dodx's
 * CP_default_owner, so it never has this problem.
 *
 * Usage:
 *   node e2e/repro/score-tick-analyze.cjs <events.jsonl[.gz]> [--defaults AAnXX]
 *
 *   --defaults  one char per flag_id in DLL index order:
 *                 A = allies-default, X = axis-default, n = neutral-default
 *               e.g. dod_thunder2/donner layout is AAnXX
 *               Omit to analyse the CLOCK only (tick detection needs no defaults).
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

// The estimator itself lives in the backend so the jest suite and this CLI can
// never drift apart. ts-node is a devDependency; register it on demand.
require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', target: 'es2019', esModuleInterop: true },
});
const { analyzeScoreTicks } = require(
    path.join(__dirname, '..', '..', 'backend', 'src', 'invariants', 'scoreTick.ts'));

function usage(msg) {
    if (msg) console.error('error: ' + msg + '\n');
    console.error(fs.readFileSync(__filename, 'utf8')
        .split('\n').slice(1).filter(l => l.startsWith(' *')).join('\n')
        .replace(/^ \*\/?/gm, '').trim());
    process.exit(msg ? 2 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) usage();

const file = argv[0];
let defaults;
const di = argv.indexOf('--defaults');
if (di !== -1) {
    const spec = argv[di + 1];
    if (!spec || !/^[AXn]+$/.test(spec)) usage('--defaults must be a string of A / X / n, e.g. AAnXX');
    defaults = {};
    [...spec].forEach((c, i) => {
        defaults[i] = c === 'A' ? 'allies' : c === 'X' ? 'axis' : 'neutral';
    });
}

if (!fs.existsSync(file)) usage(`no such file: ${file}`);
const raw = file.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
    : fs.readFileSync(file, 'utf8');

const events = [];
let badLines = 0;
for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch (_) { badLines++; }
}
if (!events.length) usage('no parseable events in ' + file);

const map = events.find(e => e.map)?.map || '(unknown)';
const matchId = events.find(e => e.match_id)?.match_id || '(unknown)';
const r = analyzeScoreTicks(events, defaults ? { defaultOwners: defaults } : {});

const halves = [...new Set(r.ticks.map(t => t.half))].sort();
const fmt = n => (Math.round(n * 100) / 100).toString();

console.log(`\nmatch ${matchId}   map ${map}   ${events.length} events` +
    (badLines ? `   (${badLines} unparseable lines skipped)` : ''));
console.log(`defaults: ${defaults
    ? Object.entries(defaults).map(([k, v]) => `${k}=${v}`).join(' ')
    : 'NOT SUPPLIED — clock analysis only, no award model check'}`);

console.log('\n── ticks ──────────────────────────────────────────────');
console.log(`confirmed        ${r.ticks.length}` +
    halves.map(h => `   half ${h}: ${r.ticks.filter(t => t.half === h).length}`).join(''));
console.log(`locks            ${r.locks.map(l => `h${l.half}@${fmt(l.gt)} (period ${fmt(l.period)}s)`).join('   ') || '(never locked)'}`);
const periods = [...new Set(r.ticks.map(t => Math.round(t.period * 100) / 100))];
console.log(`periods seen     ${periods.map(fmt).join(', ') || '-'}`);
console.log(`grid gate        ${r.gridDisabled ? 'DISABLED (no frame landed on the 0.5s grid)' : 'enabled'}`);
console.log(`rolled slots     ${r.ticks.filter(t => t.slots > 1).length} tick(s) confirmed more than one slot after the previous`);
console.log(`cap-contaminated ${r.ticks.filter(t => t.capDirty).length} (phase-only; never fed the model)`);

const by = {};
r.rejected.forEach(x => { by[x.reason] = (by[x.reason] || 0) + 1; });
console.log(`rejected         ${Object.entries(by).map(([k, v]) => `${k}:${v}`).join('  ') || '(none)'}`);

console.log('\n── award model ────────────────────────────────────────');
if (!defaults) {
    console.log('SKIPPED — rerun with --defaults to validate the projected points.');
} else {
    console.log(`W                ${r.w === null ? 'UNKNOWN' : r.w}` +
        (r.wFailed ? '   (LATCHED OFF after a model violation)' : `   (streak ${r.wStreak})`));
    console.log(`mismatches       ${r.mismatches.length}`);
    r.mismatches.forEach(m => console.log(
        `   h${m.half}@${fmt(m.gt)}  dA=${m.allies} dX=${m.axis}  held ${m.heldAllies}/${m.heldAxis}  — ${m.detail}`));

    // Per-half W, the cross-check the gate asks for.
    for (const h of halves) {
        const hs = r.ticks.filter(t => t.half === h && !t.capDirty);
        const ws = new Set();
        hs.forEach(t => {
            if (t.heldAllies > 0 && t.allies % t.heldAllies === 0) ws.add(t.allies / t.heldAllies);
            if (t.heldAxis > 0 && t.axis % t.heldAxis === 0) ws.add(t.axis / t.heldAxis);
        });
        console.log(`half ${h} weights   {${[...ws].sort((a, b) => a - b).join(', ')}}`);
    }
}

console.log('\n── period stability ───────────────────────────────────');
let unstable = 0;
for (const h of halves) {
    const hticks = r.ticks.filter(t => t.half === h);
    const gaps = [];
    let rephased = 0;
    for (let i = 1; i < hticks.length; i++) {
        // A round restart re-phases the grid, so the gap into the first tick of
        // a new phase run spans two unrelated phases and says nothing about
        // period stability. `slots === 0` marks that first tick (the bootstrap
        // candidate); skip it rather than report a restart as instability.
        if (hticks[i].slots === 0) { rephased++; continue; }
        gaps.push(+(hticks[i].gt - hticks[i - 1].gt).toFixed(3));
    }
    const runs = [...new Set(gaps)];
    // A gap of exactly N periods is a slot the master awarded 0/0 on — invisible
    // by design, not a missed tick.
    const strays = runs.filter(g => periods.every(p => {
        const k = Math.round(g / p);
        return k < 1 || Math.abs(g - k * p) > 0.05;
    }));
    if (strays.length) unstable += strays.length;
    console.log(`half ${h}          ${hticks.length} ticks, gaps {${runs.join(', ')}}` +
        (rephased ? `   (${rephased} re-phase gap skipped)` : '') +
        (strays.length ? `   STRAY: ${strays.join(', ')}` : ''));
}

console.log('\n── verdict ────────────────────────────────────────────');
const problems = [];
if (!r.ticks.length) problems.push('no ticks confirmed — the clock would never appear on this recording');
if (defaults) {
    if (r.wFailed) problems.push('award model violated — the numbers would be dark on this map');
    else if (r.w === null) problems.push('W never established — the numbers would stay dark');
}
if (unstable) problems.push(`${unstable} stray inter-tick gap(s) — period not stable`);
if (r.gridDisabled) problems.push('grid gate fell back — check this server\'s frame timing');

if (!problems.length) {
    console.log(defaults
        ? `PASS — clock and projected points both validated on ${map}.`
        : `PASS (clock only) — rerun with --defaults to validate the points on ${map}.`);
} else {
    console.log('ATTENTION:');
    problems.forEach(p => console.log('  - ' + p));
}
console.log();
