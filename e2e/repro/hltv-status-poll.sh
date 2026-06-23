#!/usr/bin/env bash
# Objective Bug-1 probe for the local full-stack repro.
#
# Polls the backend's /api/hltv/status once a second and prints, per HLTV-synced
# server: queueDepth, online, broadcastNow, sampleAgeMs. The delay buffer's
# queueDepth is the tell at a half/match changelevel:
#
#   BUG (old buffer):  queueDepth snaps to ~0 the instant the tick resets
#                      (the whole tail is flushed instantly — delay collapsed).
#   FIX (new buffer):  queueDepth jumps as the old-map tail moves to the
#                      wall-clock drain, then decays smoothly over ~delay seconds.
#
# Usage:  bash e2e/repro/hltv-status-poll.sh [api_base]
#         (default api_base http://localhost:3001)
API="${1:-http://localhost:3001}"
echo "polling $API/api/hltv/status (Ctrl-C to stop)"
printf '%-12s | %-22s | %5s | %6s | %8s | %s\n' "time" "server" "qDep" "online" "bcastNow" "sampleAge(ms)"
while true; do
  ts="$(date +%H:%M:%S)"
  curl -fsS "$API/api/hltv/status" 2>/dev/null \
    | jq -r --arg ts "$ts" '.servers[]? | [$ts, .server, (.queueDepth//0), (.online//false), (.broadcastNow//"-"), (.sampleAgeMs//"-")] | @tsv' 2>/dev/null \
    | while IFS=$'\t' read -r t s q o b a; do
        printf '%-12s | %-22s | %5s | %6s | %8s | %s\n' "$t" "$s" "$q" "$o" "$b" "$a"
      done
  sleep 1
done
