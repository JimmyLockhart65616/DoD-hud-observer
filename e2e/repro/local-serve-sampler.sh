#!/usr/bin/env bash
# Serve-clock sampler — runs INSIDE the local data container.
#
# Appends timestamped anchors of HLTV's true broadcast serve point to a CSV:
#     epochMs,spectatorTime,worldTime,delay
#
# `Spectator Time` comes from the KTPReHLDS `status` output (the KTP patch that
# surfaces Proxy::GetSpectatorTime, i.e. m_ClientWorldTime). It is the game time
# the proxy is CURRENTLY serving to viewers — the machine-readable stand-in for
# "what the caster sees", with no client and no relay hop in the path.
#
# Why stdin and not rcon: on the local stack rcon accepts the challenge and
# returns a well-formed but entirely NUL response — the command never dispatches.
# Driving the console through the wrapper's FIFO works, so we do that. (Prod's
# rcon works fine; use rcon there.)
#
# The epoch stamp is taken immediately BEFORE the command is written, so the
# observation error is one HLTV frame (~11ms at 91 FPS) rather than a docker-exec
# round trip.
#
# Usage: local-serve-sampler.sh [port] [interval_seconds] [out_csv]
set -u

PORT="${1:-27020}"
INTERVAL="${2:-10}"
OUT="${3:-/tmp/serveclock.csv}"
PIPE="/tmp/cmdpipes/hltv-${PORT}.pipe"
# The wrapper's tee'd copy, NOT supervisord's log — supervisord flushes on its
# own schedule and destroys the wall-clock correlation this sampler depends on.
LOG="/tmp/hltv-${PORT}.live.log"

[ -p "$PIPE" ] || { echo "no FIFO at $PIPE — is the wrapper running?" >&2; exit 1; }
[ -f "$OUT" ] || echo "epochMs,spectatorTime,worldTime,delay" > "$OUT"

while true; do
    before=$(wc -l < "$LOG")
    ts=$(date +%s%3N)
    echo "status" > "$PIPE"
    sleep 1
    # Only look at lines the command just produced, so a stale block can't be
    # mistaken for a fresh sample.
    new=$(tail -n +$((before + 1)) "$LOG")
    spec=$(echo "$new" | grep -oE "Spectator Time [0-9.]+, World Time [0-9.]+" | tail -1)
    delay=$(echo "$new" | grep -oE "Delay [0-9]+" | tail -1 | awk '{print $2}')
    if [ -n "$spec" ]; then
        s=$(echo "$spec" | awk '{gsub(/,/,"",$3); print $3}')
        w=$(echo "$spec" | awk '{print $6}')
        echo "${ts},${s},${w},${delay:-}" >> "$OUT"
    fi
    sleep "$INTERVAL"
done
