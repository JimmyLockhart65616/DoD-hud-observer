#!/usr/bin/env sh
# B4 — STRESS TEST against the local full-stack docker repro. Exercises the
# changelevel (half boundary) and asserts the delay-buffer's drain invariant holds
# under stress: at a map change the reorder buffer must NOT snap to 0 — old-map
# events drain on a wall-clock queue (hltvDelayBuffer.drainTail), so queueDepth
# decays smoothly across the boundary. Also checks no broadcastNow STEP and that
# delaySeconds re-reads after the map change.
#
# Drives the boundary itself if you pass game rcon + a map; otherwise it just
# monitors while YOU trigger the changelevel / reconnects (mocker, test-dispatch
# natives, or in-game). High event-rate load should be driven in parallel (mocker
# or a real local match) — this script monitors the buffer, it doesn't generate load.
#
# Flags (defaults match the local stack):
#   --server "KTP Local Dev #1"  --api http://localhost:3001  --socket http://localhost:4000
#   --hltv 127.0.0.1:27020  --hltv-pw localdev-rcon
#   --game-rcon host:port   --game-pw <pw>   --changelevel <map>   # optional: auto-trigger the boundary
#   --settle 20             # seconds to monitor before triggering the changelevel
#   --duration 90           # total seconds to monitor
#   --interval 1000         # ms between samples (1s to catch the drain curve)
#   --csv ./segment-stress.csv
set -eu

SERVER="KTP Local Dev #1"; API="http://localhost:3001"; SOCKET="http://localhost:4000"
HLTV="127.0.0.1:27020"; HLTV_PW="localdev-rcon"
GAME_RCON=""; GAME_PW=""; CHANGEMAP=""
SETTLE="20"; DURATION="90"; INTERVAL="1000"; CSV="./segment-stress.csv"
HERE="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --server) SERVER="$2"; shift 2 ;;
        --api) API="$2"; shift 2 ;;
        --socket) SOCKET="$2"; shift 2 ;;
        --hltv) HLTV="$2"; shift 2 ;;
        --hltv-pw) HLTV_PW="$2"; shift 2 ;;
        --game-rcon) GAME_RCON="$2"; shift 2 ;;
        --game-pw) GAME_PW="$2"; shift 2 ;;
        --changelevel) CHANGEMAP="$2"; shift 2 ;;
        --settle) SETTLE="$2"; shift 2 ;;
        --duration) DURATION="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --csv) CSV="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

rm -f "$CSV"
echo "stress test: monitoring server=\"$SERVER\" for ${DURATION}s @ ${INTERVAL}ms -> $CSV"
# shellcheck disable=SC2086
node "$HERE/segment-probe.cjs" "$SERVER" --api "$API" --socket "$SOCKET" \
    --hltv "$HLTV" --hltv-pw "$HLTV_PW" --interval "$INTERVAL" --csv "$CSV" &
PROBE=$!
trap 'kill "$PROBE" 2>/dev/null || true' EXIT INT TERM

if [ -n "$GAME_RCON" ] && [ -n "$GAME_PW" ] && [ -n "$CHANGEMAP" ]; then
    echo "settling ${SETTLE}s, then changelevel $CHANGEMAP via game rcon $GAME_RCON ..."
    sleep "$SETTLE"
    GH="${GAME_RCON%:*}"; GP="${GAME_RCON##*:}"
    node "$HERE/rcon.cjs" "$GH" "$GP" "$GAME_PW" changelevel "$CHANGEMAP" || echo "(changelevel rcon failed — trigger it manually)"
else
    echo "no --game-rcon/--changelevel given — trigger the half boundary + load manually now."
fi

REMAIN=$((DURATION - SETTLE))
[ "$REMAIN" -lt 1 ] && REMAIN=1
sleep "$REMAIN"
kill "$PROBE" 2>/dev/null || true
trap - EXIT INT TERM
sleep 1

echo ""
node "$HERE/analyze-segment-csv.cjs" "$CSV" --delay 60 || true

# Drain invariant: across each map change, queueDepth must stay > 0 for a few
# samples (events drain on the wall-clock queue) — a snap straight to 0 is the
# old instant-flush bug. Reported here as a focused PASS/FAIL.
echo ""
node - "$CSV" <<'NODE'
const fs = require('fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const h = rows[0].split(',');
const idx = (n) => h.indexOf(n);
const data = rows.slice(1).map((l) => l.split(','));
let cur = null, fail = false, changes = 0;
for (let i = 0; i < data.length; i++) {
    const map = data[i][idx('map')];
    if (map !== cur) {
        if (cur !== null) {
            changes++;
            // look at queueDepth for this + next 2 samples
            const window = data.slice(i, i + 3).map((r) => parseInt(r[idx('queueDepth')], 10)).filter((x) => !Number.isNaN(x));
            const minQ = window.length ? Math.min(...window) : null;
            const ok = minQ === null || minQ > 0;
            if (!ok) fail = true;
            console.log(`  changelevel #${changes} -> ${map}: queueDepth window=[${window.join(',')}]  ${ok ? 'PASS (drains smoothly)' : 'FAIL (snapped to 0)'}`);
        }
        cur = map;
    }
}
if (changes === 0) console.log('  (no changelevel observed in the CSV — trigger one during the run)');
console.log(`\nDRAIN INVARIANT: ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
NODE
