#!/usr/bin/env bash
#
# Distribute KTPHudObserver.amxx to the WHOLE KTP fleet via Tony's
# KTPFileDistributor. Drops the compiled binary into the data server's watch
# directory; the distributor SFTPs it to every server in servers.json (all 25
# game instances) within ~5s and posts to Discord.
#
# Distributing keeps the binary BYTE-IDENTICAL across the fleet wherever it
# runs. It does NOT enable the plugin: a server only LOADS KTPHudObserver if
# its plugins.ini lists KTPHudObserver.amxx. Servers without that line hold the
# newest binary DORMANT on disk (intended — the HUD stays opt-in per server).
# Enable/canary a single server with deploy-plugin.sh.
#
# Activation: the distributor overwrites the LIVE .amxx (not .new). A running
# server keeps the old bytecode in memory until its next restart (nightly 3 AM
# or a manual changelevel/restart) — no mid-match swap. Canary a new build on
# one server (deploy-plugin.sh) and verify BEFORE distributing fleet-wide.
#
# Usage:
#   ./deploy/distribute-plugin.sh --dry-run    # show the drop, change nothing
#   ./deploy/distribute-plugin.sh              # confirm, then drop to the fleet
#   ./deploy/distribute-plugin.sh --yes        # skip the confirmation prompt
#
# Flags:
#   --plugin <path>  Override the binary (default: the documented compile output
#                    ../KTPInfrastructure/local/plugins/KTPHudObserver.amxx).
#   --yes / -y       Skip the confirmation prompt.
#   --dry-run        Print every remote command, change nothing.
#
# Env overrides:
#   DIST_HOST=cadaver@74.91.112.242    — data server running KTPFileDistributor
#   DIST_WATCH=/home/dod/distribute    — distributor WatchDirectory
#   DIST_SUBPATH=addons/ktpamx/plugins — path under the dod gamedir the file
#                                        must keep (the distributor preserves
#                                        the path relative to the watch dir)
#   DIST_OWNER=distributor             — owner:group of files in the watch dir
#   KTP_INFRA_ROOT / PLUGIN_FILE       — same as deploy-plugin.sh
#
# NOTE: every drop posts a success/failure message to Tony's Discord (the
# distributor notifies on each change) — it's an audit trail, not a private op.

set -euo pipefail

DIST_HOST="${DIST_HOST:-cadaver@74.91.112.242}"
DIST_WATCH="${DIST_WATCH:-/home/dod/distribute}"
DIST_SUBPATH="${DIST_SUBPATH:-addons/ktpamx/plugins}"
DIST_OWNER="${DIST_OWNER:-distributor}"

DO_YES=0
DRY_RUN=0
PLUGIN_OVERRIDE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plugin)   PLUGIN_OVERRIDE="$2"; shift 2 ;;
        --yes|-y)   DO_YES=1; shift ;;
        --dry-run)  DRY_RUN=1; shift ;;
        --help|-h)  sed -n '3,40p' "$0"; exit 0 ;;
        *)          echo "unknown flag: $1" >&2; exit 1 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default to the documented compile output in the sibling infra repo, NOT the
# gitignored repo-root KTPHudObserver.amxx (that copy goes stale silently).
KTP_INFRA_ROOT="${KTP_INFRA_ROOT:-$(cd "$REPO_ROOT/.." && pwd)/KTPInfrastructure}"
PLUGIN_FILE="${PLUGIN_OVERRIDE:-${PLUGIN_FILE:-$KTP_INFRA_ROOT/local/plugins/KTPHudObserver.amxx}}"

if [[ ! -f "$PLUGIN_FILE" ]]; then
    echo "error: plugin not found at $PLUGIN_FILE" >&2
    echo "       compile it first (see CLAUDE.md → 'Compiling the AMXX Plugin')," >&2
    echo "       or pass --plugin <path>." >&2
    exit 1
fi

# Staleness guard: warn (don't fail) if the binary predates its own source.
SMA_SRC="$REPO_ROOT/KTPHudObserver.sma"
if [[ -f "$SMA_SRC" && "$PLUGIN_FILE" -ot "$SMA_SRC" ]]; then
    echo "WARNING: $PLUGIN_FILE is OLDER than KTPHudObserver.sma — recompile before distributing?" >&2
fi

DEST="$DIST_WATCH/$DIST_SUBPATH/KTPHudObserver.amxx"
TMP="/tmp/KTPHudObserver.amxx.$$"
SIZE=$(wc -c <"$PLUGIN_FILE")

echo "═══════════════════════════════════════════════════════════════"
echo " KTPHudObserver fleet distribute  (via KTPFileDistributor)"
echo "   binary : $PLUGIN_FILE ($SIZE bytes)"
echo "   data   : $DIST_HOST"
echo "   drop   : $DEST"
echo "   reach  : every enabled server in servers.json (all 25 KTP instances)"
echo "   loads  : only where plugins.ini lists KTPHudObserver.amxx; else dormant"
echo "   when   : at each server's next restart (nightly 3 AM / manual)"
echo "   notify : posts to Tony's Discord on completion"
echo "═══════════════════════════════════════════════════════════════"

if [[ "$DRY_RUN" == 0 && "$DO_YES" == 0 && -t 0 ]]; then
    read -r -p "Drop to the fleet? [y/N] " ans
    [[ "$ans" == [yY] || "$ans" == [yY][eE][sS] ]] || { echo "Aborted."; exit 1; }
fi

if [[ "$DRY_RUN" == 1 ]]; then
    echo "DRY: scp $PLUGIN_FILE $DIST_HOST:$TMP"
    echo "DRY: ssh $DIST_HOST -- sudo install -o $DIST_OWNER -g $DIST_OWNER -m 0664 $TMP $DEST && rm -f $TMP"
    echo "==> Dry run complete, no remote changes"
    exit 0
fi

# scp lands the binary in /tmp as the SSH user, then a single sudo install copies
# it into the watch dir with the same owner:group:mode as its siblings (664
# distributor:distributor) so the ftpuser service can read+ship it. The write
# triggers the FileSystemWatcher → fan-out begins after the 5s debounce.
scp "$PLUGIN_FILE" "$DIST_HOST:$TMP"
ssh "$DIST_HOST" "sudo install -o $DIST_OWNER -g $DIST_OWNER -m 0664 '$TMP' '$DEST' && rm -f '$TMP'"

echo "==> Dropped. KTPFileDistributor fans out within ~5s (watch its Discord post)."
echo "    Verify: ssh $DIST_HOST \"sudo journalctl -u ktp-file-distributor -n 40 --no-pager\""
