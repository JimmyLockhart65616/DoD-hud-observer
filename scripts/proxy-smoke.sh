#!/usr/bin/env bash
#
# proxy-smoke.sh — verify the single-origin reverse proxy actually routes.
#
# The overlay is served single-origin behind nginx (prod: https://hud.ktpdod.com;
# local docker: http://localhost:8080) so the browser + OBS's CEF never hit a
# cross-origin/mixed-content wall. This smoke asserts the three routes fan out
# correctly through that ONE origin:
#
#   GET  /health                                → backend REST  (:3001)  → {"status":"ok"}
#   GET  /socket.io/?EIO=4&transport=polling    → Socket.IO      (:4000)  → EIO handshake ("0{...sid...}")
#   GET  /                                       → React overlay (:3000)  → HTML shell
#
# Run against a live stack (docker `data` container up, or a prod host):
#   npm run proxy:smoke                          # default http://localhost:8080
#   BASE_URL=https://hud.ktpdod.com npm run proxy:smoke
#
# Exit codes:
#   0 — all three routes healthy
#   1 — a route failed / returned the wrong thing
#   3 — environment problem (curl missing, nothing listening at BASE_URL)

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

if ! command -v curl >/dev/null 2>&1; then
    red "ERROR: curl not found"
    exit 3
fi

echo "==> Single-origin proxy smoke against $BASE_URL"

# Reachability — distinguish "proxy down" (env) from "route wrong" (failure).
if ! curl -sS -o /dev/null --max-time 5 "$BASE_URL/health" 2>/dev/null; then
    red "ERROR: nothing answered at $BASE_URL/health — is the stack up?"
    red "  Local: DOD_HUD_PATH=../DoD-hud-observer make local-up-full (in KTPInfrastructure)"
    red "         or: docker compose up -d (in this repo)"
    exit 3
fi

fail=0

# 1) /health → backend REST
health="$(curl -sS --max-time 5 "$BASE_URL/health")"
if printf '%s' "$health" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    green "  OK  /health → $health"
else
    red   "  FAIL /health did not return status:ok → $health"
    fail=1
fi

# 2) /socket.io/ handshake → Socket.IO. Engine.IO v4 opens the polling handshake
#    with a packet type '0' followed by JSON containing a session id ("sid").
sio="$(curl -sS --max-time 5 "$BASE_URL/socket.io/?EIO=4&transport=polling")"
if printf '%s' "$sio" | grep -q '"sid"'; then
    green "  OK  /socket.io/ → handshake carries sid"
else
    red   "  FAIL /socket.io/ handshake missing sid (WS upgrade / proxy_pass wrong?) → ${sio:0:120}"
    fail=1
fi

# 3) / → React overlay HTML shell
root="$(curl -sS --max-time 5 "$BASE_URL/")"
if printf '%s' "$root" | grep -qi '<div id="root"'; then
    green "  OK  / → React shell served"
else
    red   "  FAIL / did not serve the React shell → ${root:0:120}"
    fail=1
fi

if [ "$fail" -ne 0 ]; then
    red "==> proxy smoke FAILED"
    exit 1
fi
green "==> proxy smoke passed — single origin routes /health, /socket.io/, and / correctly"
