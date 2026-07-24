#!/usr/bin/env bash
#
# proxy-smoke.sh — verify the single-origin reverse proxy actually routes.
#
# The overlay is served single-origin behind nginx (local: https://localhost;
# prod: https://hud.ktpdod.com) so the browser + OBS's CEF never hit a cross-origin
# / mixed-content wall and Socket.IO upgrades to wss. This smoke asserts the three
# routes fan out correctly through that ONE origin:
#
#   GET  /health                                → backend REST  (:3001) → {"status":"ok"}
#   GET  /socket.io/?EIO=4&transport=polling    → Socket.IO      (:4000) → EIO handshake (sid)
#   GET  /                                       → React overlay (:3000) → HTML shell
#
# Defaults target the LOCAL docker :443 stack with zero setup — https://localhost
# (resolves natively, no hosts file) and -k (this is a ROUTING test; the trusted
# padlock is a browser/OBS check, not this script's job).
#
#   npm run proxy:smoke                                   # local https://localhost (:443)
#   BASE_URL=http://localhost npm run proxy:smoke         # local :80 (redirects → :443)
#   BASE_URL=https://hud.ktpdod.com SMOKE_STRICT=1 npm run proxy:smoke  # PROD (real DNS + valid cert)
#
# Env:
#   BASE_URL      origin to probe            (default https://localhost)
#   SMOKE_RESOLVE optional curl --resolve mapping (e.g. hud.ktpdod.com:443:127.0.0.1 to test that name locally)
#   SMOKE_STRICT  1 = validate the cert (no -k); default off for the local self-signed/mkcert case
#
# Exit codes: 0 all routes healthy · 1 a route failed · 3 env problem (no curl / nothing listening)

set -euo pipefail

BASE_URL="${BASE_URL:-https://localhost}"
SMOKE_RESOLVE="${SMOKE_RESOLVE-}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

command -v curl >/dev/null 2>&1 || { red "ERROR: curl not found"; exit 3; }

# Assemble curl options: --resolve (skip hosts file) + -k unless strict.
CURL_OPTS=(-sS --max-time 5)
[ -n "$SMOKE_RESOLVE" ] && CURL_OPTS+=(--resolve "$SMOKE_RESOLVE")
[ "${SMOKE_STRICT:-0}" = "1" ] || CURL_OPTS+=(-k)
c() { curl "${CURL_OPTS[@]}" "$@"; }

echo "==> Single-origin proxy smoke against $BASE_URL"
[ -n "$SMOKE_RESOLVE" ] && echo "    (--resolve $SMOKE_RESOLVE)"

# Reachability — distinguish "proxy down" (env) from "route wrong" (failure).
if ! c -o /dev/null "$BASE_URL/health" 2>/dev/null; then
    red "ERROR: nothing answered at $BASE_URL/health — is the stack up?"
    red "  Local: DOD_HUD_PATH=../DoD-hud-observer make local-up-full (in KTPInfrastructure)"
    red "         or: docker compose up -d (in this repo)"
    exit 3
fi

fail=0

health="$(c "$BASE_URL/health")"
if printf '%s' "$health" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    green "  OK  /health → $health"
else
    red   "  FAIL /health did not return status:ok → $health"; fail=1
fi

# Engine.IO v4 opens the polling handshake with a '0' packet carrying a session id.
sio="$(c "$BASE_URL/socket.io/?EIO=4&transport=polling")"
if printf '%s' "$sio" | grep -q '"sid"'; then
    green "  OK  /socket.io/ → handshake carries sid"
else
    red   "  FAIL /socket.io/ handshake missing sid (wss upgrade / proxy_pass wrong?) → ${sio:0:120}"; fail=1
fi

root="$(c "$BASE_URL/")"
if printf '%s' "$root" | grep -qi '<div id="root"'; then
    green "  OK  / → React shell served"
else
    red   "  FAIL / did not serve the React shell → ${root:0:120}"; fail=1
fi

if [ "$fail" -ne 0 ]; then
    red "==> proxy smoke FAILED"; exit 1
fi
green "==> proxy smoke passed — single origin routes /health, /socket.io/, and / correctly"
