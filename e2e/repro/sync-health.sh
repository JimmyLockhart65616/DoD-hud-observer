#!/usr/bin/env bash
# Health gate for the durable HLTV↔overlay sync monitor (runs ON the data server
# via sync-health.timer; failure fans out to Discord through
# OnFailure=ktp-systemd-alert@%n.service).
#
# Why this exists: on 2026-07-24 the three delay-0 relays were stopped and the
# sync-relay@.service unit removed, but sync-logger.service kept running and
# exiting 0. From systemd's view nothing had failed, so no OnFailure fired —
# the logger just wrote rows with relayGameTime/proxySrvDelay/relayVsOverlay
# BLANK and RELAY_DOWN in the flags column for 3.5 days. The footage side of
# every measurement was gone and nothing said so.
#
# So a live logger is NOT the health signal. The signal is: are the footage
# columns actually being populated? That's what this checks.
#
# Exit 0 = healthy, 1 = degraded (reasons on stdout → journald → Discord embed).
set -uo pipefail

LOG_DIR="${SYNC_LOG_DIR:-/opt/sync-monitor/logs}"
RELAY_PORTS="${SYNC_RELAY_PORTS:-27060 27061 27062}"
# The logger ticks every 10s; 120s tolerates a restart without flapping.
STALE_SECONDS="${SYNC_STALE_SECONDS:-120}"
# Rows scanned for footage-column population. 90 ≈ 30 ticks × 3 servers ≈ the
# last 5 minutes — long enough that a changelevel (relay briefly drops and
# autoretries) doesn't trip the alert, short enough to catch a real outage
# within one timer interval.
WINDOW_ROWS="${SYNC_WINDOW_ROWS:-90}"

problems=()

for p in $RELAY_PORTS; do
    state="$(systemctl is-active "sync-relay@$p" 2>/dev/null || true)"
    [ "$state" = "active" ] || problems+=("sync-relay@$p is ${state:-unknown}")
done

logger_state="$(systemctl is-active sync-logger 2>/dev/null || true)"
[ "$logger_state" = "active" ] || problems+=("sync-logger is ${logger_state:-unknown}")

csv="$(ls -t "$LOG_DIR"/sync-*.csv 2>/dev/null | head -1)"
if [ -z "$csv" ]; then
    problems+=("no CSV found in $LOG_DIR")
else
    age=$(( $(date +%s) - $(stat -c %Y "$csv") ))
    if [ "$age" -gt "$STALE_SECONDS" ]; then
        problems+=("CSV stale ${age}s (>${STALE_SECONDS}s): $(basename "$csv")")
    fi
    # The load-bearing check: relayVsOverlay (col 16) populated per server.
    # A server present in the window with zero populated rows is measuring
    # nothing on the footage side, however healthy the units look.
    blind="$(tail -n "$WINDOW_ROWS" "$csv" \
        | awk -F, '$3 != "" { n[$3]++; if ($16 != "") ok[$3]++ }
                   END { for (s in n) if (!(s in ok)) printf "%s; ", s }')"
    [ -z "$blind" ] || problems+=("footage columns blank for: ${blind%; }")
fi

if [ "${#problems[@]}" -gt 0 ]; then
    echo "sync-monitor DEGRADED — the overlay↔footage measurement is blind:"
    printf '  - %s\n' "${problems[@]}"
    echo "Restore: sudo systemctl start sync-relay@27060 sync-relay@27061 sync-relay@27062"
    echo "         (if the unit is missing, re-run ~/sync-stage/deploy-sync-monitor.sh)"
    exit 1
fi

echo "sync-monitor healthy: relays up, logger writing $(basename "$csv"), footage columns populated"
