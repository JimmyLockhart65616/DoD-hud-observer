#!/usr/bin/env sh
# B3 — DECAY TEST (long-run drift) against the local full-stack docker repro.
#
# Runs segment-probe at a steady cadence for a while, then grades the CSV: in a
# healthy stack the per-segment offsets stay FLAT (overlayLag ≈ delay, clockErrPx
# ≈ 0 with no slope, proxySrvDelay constant, no STEP). A slope or growing sd is
# how we learn constant-vs-drift BEFORE risking it on a live match.
#
# Prereqs: the KTPInfrastructure local stack is up with hltv_sync enabled and the
# proxy delay set to a known value:
#   cd ../KTPInfrastructure && make local-up
#   # ensure test-env/data/hltv-1.cfg has `delay 60` (it does by default)
#
# Defaults match KTPInfrastructure/config/local + test-env/data/hltv-1.cfg.
# Override via flags:
#   --server   game-server hostname key            (default "KTP Local Dev #1")
#   --api      backend REST base                    (default http://localhost:3001)
#   --socket   backend Socket.IO base               (default http://localhost:4000)
#   --hltv     master proxy host:port               (default 127.0.0.1:27020)
#   --hltv-pw  master adminpassword                 (default localdev-rcon)
#   --relay    optional relay host:port (if launched via relay-launch.sh)
#   --relay-pw relay adminpassword
#   --delay    expected configured delay (grading)  (default 60)
#   --duration seconds to sample                     (default 300)
#   --interval ms between samples                    (default 5000)
#   --csv      output path                           (default ./segment-decay.csv)
set -eu

SERVER="KTP Local Dev #1"; API="http://localhost:3001"; SOCKET="http://localhost:4000"
HLTV="127.0.0.1:27020"; HLTV_PW="localdev-rcon"; RELAY=""; RELAY_PW=""
DELAY="60"; DURATION="300"; INTERVAL="5000"; CSV="./segment-decay.csv"
HERE="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --server) SERVER="$2"; shift 2 ;;
        --api) API="$2"; shift 2 ;;
        --socket) SOCKET="$2"; shift 2 ;;
        --hltv) HLTV="$2"; shift 2 ;;
        --hltv-pw) HLTV_PW="$2"; shift 2 ;;
        --relay) RELAY="$2"; shift 2 ;;
        --relay-pw) RELAY_PW="$2"; shift 2 ;;
        --delay) DELAY="$2"; shift 2 ;;
        --duration) DURATION="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --csv) CSV="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

rm -f "$CSV"
RELAY_ARGS=""
[ -n "$RELAY" ] && [ -n "$RELAY_PW" ] && RELAY_ARGS="--relay $RELAY --relay-pw $RELAY_PW"

echo "decay test: server=\"$SERVER\" duration=${DURATION}s interval=${INTERVAL}ms -> $CSV"
# shellcheck disable=SC2086
node "$HERE/segment-probe.cjs" "$SERVER" --api "$API" --socket "$SOCKET" \
    --hltv "$HLTV" --hltv-pw "$HLTV_PW" $RELAY_ARGS --interval "$INTERVAL" --csv "$CSV" &
PROBE=$!
trap 'kill "$PROBE" 2>/dev/null || true' EXIT INT TERM
sleep "$DURATION"
kill "$PROBE" 2>/dev/null || true
trap - EXIT INT TERM
sleep 1

echo ""
node "$HERE/analyze-segment-csv.cjs" "$CSV" --delay "$DELAY"
