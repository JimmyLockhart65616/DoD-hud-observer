// Analyze a segment-probe CSV: per-column stats + flatness/slope + STEP count +
// across-changelevel behavior, with a PASS/FAIL verdict. Used both to grade the
// local decay test (B3) and to read the live match-day dataset (constant-vs-drift).
//
// Usage:
//   node e2e/repro/analyze-segment-csv.cjs <csv> [--delay 60] [--flat-tol 3] [--slope-tol 2]
//     --delay      expected configured delay (overlayLag should ≈ this)
//     --flat-tol   max allowed stddev (s) for clockErrPx / proxySrvDelay to count as "flat"
//     --slope-tol  max allowed |slope| (s per minute) to count as "flat"
'use strict';
const fs = require('fs');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const CSV = process.argv[2];
const DELAY = parseFloat(arg('--delay', '60'));
const FLAT_TOL = parseFloat(arg('--flat-tol', '3'));
const SLOPE_TOL = parseFloat(arg('--slope-tol', '2'));
if (!CSV || CSV.startsWith('--')) { console.error('usage: node analyze-segment-csv.cjs <csv> [--delay N] [--flat-tol N] [--slope-tol N]'); process.exit(2); }

const lines = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
const header = lines[0].split(',');
const rows = lines.slice(1).map((l) => {
    const v = l.split(',');
    const o = {};
    header.forEach((h, i) => { o[h] = v[i]; });
    return o;
});
const col = (r, name) => { const x = parseFloat(r[name]); return Number.isNaN(x) ? null : x; };

function stats(name) {
    const xs = rows.map((r) => col(r, name)).filter((v) => v != null);
    if (!xs.length) return null;
    const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    // slope per minute via least squares over wallMs
    const t0 = parseFloat(rows[0].wallMs);
    const pts = rows.map((r) => [(parseFloat(r.wallMs) - t0) / 60000, col(r, name)]).filter((p) => p[1] != null);
    let slope = null;
    if (pts.length >= 2) {
        const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
        const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
        const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
        slope = den ? num / den : null;
    }
    return { n, mean, sd, min: Math.min(...xs), max: Math.max(...xs), slope };
}

const fmt = (v, d = 1) => (v == null ? '-' : v.toFixed(d));
const pad = (s, w) => String(s).padStart(w);

console.log(`analyzing ${CSV}  (${rows.length} samples, delay=${DELAY}s, flat-tol=${FLAT_TOL}s, slope-tol=${SLOPE_TOL}s/min)\n`);
console.log([pad('column', 16), pad('n', 4), pad('mean', 8), pad('sd', 7), pad('min', 8), pad('max', 8), pad('slope/min', 10)].join(' '));
const want = ['overlayLag', 'clockErr', 'clockErrPx', 'proxySrvDelay', 'relayVsOverlay', 'hudTimeleft', 'queueDepth'];
const S = {};
for (const c of want) {
    const st = stats(c);
    S[c] = st;
    if (st) console.log([pad(c, 16), pad(st.n, 4), pad(fmt(st.mean), 8), pad(fmt(st.sd), 7), pad(fmt(st.min), 8), pad(fmt(st.max), 8), pad(fmt(st.slope, 2), 10)].join(' '));
    else console.log([pad(c, 16), pad(0, 4), pad('-', 8)].join(' '));
}

// STEP rows
const steps = rows.filter((r) => r.step && r.step !== '' && r.step !== '0');
console.log(`\nSTEP events (broadcastNow jump, no tick reset): ${steps.length}`);
steps.slice(0, 5).forEach((r) => console.log(`  wallMs=${r.wallMs} jump=${r.step}s map=${r.map}`));

// across-changelevel: report proxySrvDelay + relayVsOverlay before/after each map change
const maps = [];
let cur = null;
rows.forEach((r, i) => { if (r.map !== cur) { maps.push({ i, map: r.map }); cur = r.map; } });
if (maps.length > 1) {
    console.log(`\nmap changes: ${maps.length - 1}  (the halftime-stability test)`);
    for (let k = 1; k < maps.length; k++) {
        const before = rows[maps[k].i - 1], after = rows[maps[k].i];
        console.log(`  ${before.map} → ${after.map}:  proxySrvDelay ${fmt(col(before, 'proxySrvDelay'))} → ${fmt(col(after, 'proxySrvDelay'))}   relayVsOverlay ${fmt(col(before, 'relayVsOverlay'))} → ${fmt(col(after, 'relayVsOverlay'))}`);
    }
}

// verdict
const checks = [];
if (S.overlayLag) checks.push(['overlayLag ≈ delay', Math.abs(S.overlayLag.mean - DELAY) <= FLAT_TOL, `mean ${fmt(S.overlayLag.mean)} vs ${DELAY}`]);
if (S.clockErrPx) checks.push(['clockErrPx flat (no host skew)', S.clockErrPx.sd <= FLAT_TOL && Math.abs(S.clockErrPx.slope ?? 0) <= SLOPE_TOL, `sd ${fmt(S.clockErrPx.sd)} slope ${fmt(S.clockErrPx.slope, 2)}`]);
if (S.proxySrvDelay) checks.push(['proxySrvDelay flat (constant serve point)', S.proxySrvDelay.sd <= FLAT_TOL && Math.abs(S.proxySrvDelay.slope ?? 0) <= SLOPE_TOL, `sd ${fmt(S.proxySrvDelay.sd)} slope ${fmt(S.proxySrvDelay.slope, 2)}`]);
checks.push(['no STEP events', steps.length === 0, `${steps.length} steps`]);

console.log('\nverdict:');
let pass = true;
for (const [label, ok, detail] of checks) { if (!ok) pass = false; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}  (${detail})`); }
// Discriminator hint (informational, not pass/fail — depends on what we're measuring)
if (S.relayVsOverlay) {
    const m = S.relayVsOverlay.mean;
    const where = Math.abs(m) <= FLAT_TOL ? 'CLIENT-side (overlay matches master serve point → per-session calibration)'
        : m < 0 ? 'PROXY-side (master serves further back than overlay → mechanism reference wrong, auto-fixable)'
            : 'overlay BEHIND master (unexpected — investigate)';
    console.log(`\ndiscriminator: relayVsOverlay mean ${fmt(m)}s ⇒ gap is ${where}`);
}
console.log(`\n${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
