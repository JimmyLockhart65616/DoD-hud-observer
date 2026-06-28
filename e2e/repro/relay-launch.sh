#!/usr/bin/env sh
# Spin a THROWAWAY HLTV relay chained off a target proxy, so relay-probe.cjs can
# rcon its "Game Time" and machine-measure the master's true serve point.
#
# A relay is just another HLTV proxy with `delay 0` that connects to the MASTER
# (instead of to a game server). Its World clock then tracks the frames it
# receives from the master = the master's broadcast serve point.
#
# === Hard-won launch facts (GoldSrc/ReHLDS hltv, verified on the local stack) ===
#  1. PORT: the relay's port MUST be set via the `-port` engine arg, NOT the cfg
#     `port` directive — hltv.cfg auto-execs BEFORE the Proxy module loads, so
#     `port` is "not registered" and silently ignored (both proxies then default
#     to 27020 and collide). Same root cause for `connect` (below).
#  2. WORKING DIR: hltv loads engine .so's (filesystem_stdio.so, engine_i486.so,
#     proxy.so, …) from its CWD. Run it from an instance dir that SYMLINKS those
#     from the hltv root (clone an existing instance — `cp -a` dereferences the
#     symlinks and breaks exec, so symlink explicitly).
#  3. CONNECT: cfg `connect` also runs too early → the relay starts "Not connected".
#     Issue it via RCON after startup. The handshake sends the relay's password in
#     userinfo, validated against the MASTER's `proxypassword`; the relay supplies
#     it via `serverpassword <master-proxypassword>` BEFORE `connect <master>`.
#     (CMD_Connect ignores a trailing password token — it must be `serverpassword`.)
#
# This script's --docker-exec mode does all of that. Default --dry-run prints the
# plan and the post-start rcon sequence without launching.
#
# Required:
#   --connect host:port        the MASTER proxy spectator port (e.g. 127.0.0.1:27020)
#   --port <n>                 the relay's own port (e.g. 27060)
#   --pw <password>            the relay's adminpassword (rcon)
#   --master-proxypw <pw>      the MASTER's proxypassword (for the relay to chain on)
#
# Mode:
#   --docker-exec <container>  launch hltv inside a container (the data container)
#   --dry-run                  (default) print the plan + rcon sequence, launch nothing
#
# Optional:
#   --hltv-root <dir>          hltv install dir in the container (default /opt/hltv)
#   --template <dir>           instance dir to mirror symlinks from (default <root>/instance-1)
#   --name "<hostname>"        relay hostname (default "KTP sync relay")
#
# Example (local docker, relay off hltv-1 inside the data container):
#   sh e2e/repro/relay-launch.sh --docker-exec ktpinfrastructure-data-1 \
#      --connect 127.0.0.1:27020 --port 27060 --pw relaypw --master-proxypw localdev-proxy
# Then (from inside the container, where 27060 lives):
#   NODE_PATH=/app/node_modules node /tmp/repro/relay-probe.cjs \
#      --master 127.0.0.1:27020 --master-pw localdev-rcon --relay 127.0.0.1:27060 --relay-pw relaypw
#
# Teardown: pkill -f instance-relay ; rm -rf <root>/instance-relay  (it's disposable).
set -eu

MODE="dry-run"; CONTAINER=""
CONNECT=""; PORT=""; PW=""; MASTER_PW=""
HLTV_ROOT="/opt/hltv"; TEMPLATE=""; NAME="KTP sync relay"

while [ $# -gt 0 ]; do
    case "$1" in
        --docker-exec) MODE="docker"; CONTAINER="$2"; shift 2 ;;
        --dry-run)     MODE="dry-run"; shift ;;
        --connect)     CONNECT="$2"; shift 2 ;;
        --port)        PORT="$2"; shift 2 ;;
        --pw)          PW="$2"; shift 2 ;;
        --master-proxypw) MASTER_PW="$2"; shift 2 ;;
        --hltv-root)   HLTV_ROOT="$2"; shift 2 ;;
        --template)    TEMPLATE="$2"; shift 2 ;;
        --name)        NAME="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done
[ -z "$TEMPLATE" ] && TEMPLATE="$HLTV_ROOT/instance-1"

if [ -z "$CONNECT" ] || [ -z "$PORT" ] || [ -z "$PW" ] || [ -z "$MASTER_PW" ]; then
    echo "error: --connect, --port, --pw, and --master-proxypw are required" >&2
    exit 2
fi

RELAY_DIR="$HLTV_ROOT/instance-relay"
CH="${CONNECT%:*}"; CP="${CONNECT##*:}"

# Commands to run (in the container for docker mode; printed for dry-run).
build_cmds() {
cat <<SH
pkill -f instance-relay 2>/dev/null || true
rm -rf "$RELAY_DIR"; mkdir -p "$RELAY_DIR/demos"; cd "$RELAY_DIR"
# (2) symlink engine files from the hltv root (don't cp -a — it dereferences)
for f in "$HLTV_ROOT"/*.so "$HLTV_ROOT"/hltv "$HLTV_ROOT"/dod "$HLTV_ROOT"/valve "$HLTV_ROOT"/cstrike "$HLTV_ROOT"/steam_appid.txt; do ln -sf "\$f" ./; done
# minimal cfg — NO port (use -port), NO connect (issue via rcon after start)
printf 'hostname "%s"\nadminpassword "%s"\nproxypassword "%s"\nnomaster 1\nmaxclients 8\ndelay 0\n' "$NAME" "$PW" "$PW" > hltv.cfg
# (1) launch with -port, detached
LD_LIBRARY_PATH="$HLTV_ROOT" "$RELAY_DIR/hltv" -port $PORT > /var/log/relay.log 2>&1 &
sleep 5
SH
}

# The post-start rcon sequence (3): serverpassword <master proxypw>, delay 0, connect <master>.
RCON_SEQ="node /tmp/repro/rcon.cjs 127.0.0.1 $PORT $PW serverpassword $MASTER_PW
node /tmp/repro/rcon.cjs 127.0.0.1 $PORT $PW delay 0
node /tmp/repro/rcon.cjs 127.0.0.1 $PORT $PW connect $CONNECT"

if [ "$MODE" = "dry-run" ]; then
    echo "[dry-run] launch sequence (run inside the hltv host/container):"
    build_cmds | sed "s/$PW/***/g; s/$MASTER_PW/***/g"
    echo "[dry-run] then issue the connect via rcon (cfg connect runs too early):"
    echo "$RCON_SEQ" | sed "s/$PW/***/g; s/$MASTER_PW/***/g"
    echo "[dry-run] pass --docker-exec <container> to actually start it."
    exit 0
fi

# docker mode
echo "launching relay in $CONTAINER on -port $PORT (master $CONNECT)..."
build_cmds | docker exec -i "$CONTAINER" sh
echo "issuing connect via rcon (serverpassword -> delay 0 -> connect)..."
echo "$RCON_SEQ" | while IFS= read -r line; do [ -n "$line" ] && docker exec "$CONTAINER" sh -c "$line" >/dev/null 2>&1 || true; done
sleep 3
echo "verify (master should show Proxies 1, relay 'Connected to HLTV Proxy'):"
docker exec "$CONTAINER" node -e '
const{rconHltvStatus}=require("/tmp/repro/lib/rcon.cjs");
(async()=>{const r=await rconHltvStatus("127.0.0.1",'"$PORT"',"'"$PW"'",4000);console.log("relay:",r&&r.gameTime!=null?("Game Time "+r.gameTime+", localProxies "+r.localProxies):JSON.stringify(r));})();' 2>&1 | head -3
echo "relay ready on 127.0.0.1:$PORT — measure with relay-probe.cjs (run inside the container)."
