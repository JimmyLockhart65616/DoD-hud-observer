#!/usr/bin/env bash
#
# Install/update KTPHudObserver.amxx on a single KTP game server.
#
# Plain plugin push + restart (the common case once a server is bootstrapped):
#   ./deploy/deploy-plugin.sh cadaver@66.163.114.109 dod-27019
#
# First-time install on a server that's never run KTPHudObserver before
# (full 5-step setup: plugin + hud_observer.cfg + dodserver.cfg exec line +
# plugins.ini line + LGSM restart):
#   ./deploy/deploy-plugin.sh --bootstrap cadaver@172.238.176.101 dod-27015
#
# Flags:
#   --bootstrap      Full first-time install (implies --cfg, edits plugins.ini
#                    and dodserver.cfg). Idempotent — safe to re-run.
#   --cfg            Also push deploy/hud_observer.cfg (URL + auth key).
#   --stage          Install the binary as KTPHudObserver.amxx.new (NOT live) and
#                    skip the restart. The nightly 3 AM restart swaps every
#                    *.new in the plugins dir into place — safe during live play,
#                    no mid-match bounce. Mutually exclusive with --bootstrap.
#   --no-restart     Skip the LGSM restart at the end (e.g. staging multiple
#                    plugins before a single restart).
#   --plugin <path>  Override the plugin file shipped (default: the compiled
#                    artifact at ../KTPInfrastructure/local/plugins/KTPHudObserver.amxx
#                    — the documented compile output, NOT the gitignored repo-root
#                    copy, which is frequently stale).
#   --dry-run        Print every remote command, run nothing.
#
# Env overrides:
#   LGSM_ROOT=/home/dodserver           — parent dir of the LGSM instance scripts
#   LGSM_USER=dodserver                 — owner of the gameserver files (chown target)
#   KTP_INFRA_ROOT=../KTPInfrastructure — sibling infra repo (default plugin source)
#   PLUGIN_FILE=<path>                  — same effect as --plugin
#
# Layout assumed on the target host:
#   $LGSM_ROOT/<instance>                                                # LGSM script
#   $LGSM_ROOT/<instance>/serverfiles/dod/dodserver.cfg                  # server config
#   $LGSM_ROOT/<instance>/serverfiles/dod/addons/ktpamx/plugins/         # .amxx files
#   $LGSM_ROOT/<instance>/serverfiles/dod/addons/ktpamx/configs/         # cfg + plugins.ini
#
# cadaver has NOPASSWD: ALL on every KTP host (see KTP fleet SSH memory),
# so every remote command goes through `sudo` without prompting.
#
# LGSM-script naming convention (relevant to step 4 below):
#   The LGSM control script lives INSIDE the instance directory and is named
#   dodserver, dodserver2, dodserver3, etc. depending on the host's instance
#   layout. The script auto-discovers it via `ls $INSTANCE_DIR/dodserver*` and
#   expects exactly one match. Fails loudly otherwise.
#     /home/dodserver/dod-27015/dodserver       (ATL/CHI/DAL/NY :27015)
#     /home/dodserver/dod-27019/dodserver5      (DEN :27019)
#   Earlier versions of this script invoked `sudo -u dodserver $INSTANCE_DIR
#   restart` directly, which fails with `sudo: <dir>: command not found`
#   because the directory itself isn't executable.

set -euo pipefail

DO_BOOTSTRAP=0
DO_CFG=0
DO_RESTART=1
DO_STAGE=0
DRY_RUN=0
PLUGIN_FILE=""

POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --bootstrap)   DO_BOOTSTRAP=1; DO_CFG=1; shift ;;
        --cfg)         DO_CFG=1; shift ;;
        --stage)       DO_STAGE=1; DO_RESTART=0; shift ;;
        --no-restart)  DO_RESTART=0; shift ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --plugin)      PLUGIN_FILE="$2"; shift 2 ;;
        --help|-h)     sed -n '3,33p' "$0"; exit 0 ;;
        --*)           echo "unknown flag: $1" >&2; exit 1 ;;
        *)             POSITIONAL+=("$1"); shift ;;
    esac
done

if [[ "$DO_STAGE" == 1 && "$DO_BOOTSTRAP" == 1 ]]; then
    echo "error: --stage and --bootstrap are mutually exclusive" >&2
    echo "       bootstrap installs plugins.ini + cfg and needs a restart to load;" >&2
    echo "       stage only drops a .new binary for the nightly swap." >&2
    exit 1
fi

if [[ ${#POSITIONAL[@]} -ne 2 ]]; then
    echo "usage: $0 [flags] <user@host> <instance>" >&2
    echo "       run with --help for full options" >&2
    exit 1
fi

HOST="${POSITIONAL[0]}"
INSTANCE="${POSITIONAL[1]}"
LGSM_ROOT="${LGSM_ROOT:-/home/dodserver}"
LGSM_USER="${LGSM_USER:-dodserver}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default to the documented compile output in the sibling infra repo, NOT the
# gitignored repo-root KTPHudObserver.amxx — that copy is a transient build
# artifact that goes stale silently and was the source of an old "deployed an
# old binary" landmine.
KTP_INFRA_ROOT="${KTP_INFRA_ROOT:-$(cd "$REPO_ROOT/.." && pwd)/KTPInfrastructure}"
PLUGIN_FILE="${PLUGIN_FILE:-$KTP_INFRA_ROOT/local/plugins/KTPHudObserver.amxx}"
CFG_FILE="$REPO_ROOT/deploy/hud_observer.cfg"

if [[ ! -f "$PLUGIN_FILE" ]]; then
    echo "error: plugin not found at $PLUGIN_FILE" >&2
    echo "       compile it first (see CLAUDE.md → 'Compiling the AMXX Plugin')," >&2
    echo "       or pass --plugin <path> / set PLUGIN_FILE=<path>." >&2
    exit 1
fi

# Staleness guard: ABORT (fail-closed) if the binary predates its own source — a
# recompile was almost certainly forgotten, so deploying would ship a STALE plugin
# (the exact landmine that shipped an old captor-only build to DEN5, 2026-06-26).
# A non-zero exit can't be missed the way a warning can (filtered logs, LGSM spam).
# Override (intentional): HUD_ALLOW_STALE=1  (HUD_SKIP_STALE_WARN kept as alias).
SMA_SRC="$REPO_ROOT/KTPHudObserver.sma"
if [[ -f "$SMA_SRC" && "$PLUGIN_FILE" -ot "$SMA_SRC" && "${HUD_ALLOW_STALE:-${HUD_SKIP_STALE_WARN:-0}}" != 1 ]]; then
    echo "error: $PLUGIN_FILE is OLDER than KTPHudObserver.sma — recompile before deploying." >&2
    echo "       The source changed since this binary was built, so deploying now would ship a" >&2
    echo "       STALE plugin. Recompile to the canonical path (CLAUDE.md -> 'Compiling the AMXX" >&2
    echo "       Plugin'), then re-run. Override (intentional): HUD_ALLOW_STALE=1." >&2
    exit 1
fi
if [[ "$DO_CFG" == 1 && ! -f "$CFG_FILE" ]]; then
    echo "error: $CFG_FILE not found (gitignored — copy from .example and fill in)" >&2
    exit 1
fi

INSTANCE_DIR="$LGSM_ROOT/$INSTANCE"
SERVER_DIR="$INSTANCE_DIR/serverfiles/dod"
PLUGIN_LIVE="$SERVER_DIR/addons/ktpamx/plugins/KTPHudObserver.amxx"
# --stage drops the binary as *.new; the nightly 3 AM restart globs
# plugins/*.new and mv -f's each into place (then chmod +x). No live overwrite,
# no mid-match restart.
if [[ "$DO_STAGE" == 1 ]]; then
    PLUGIN_DEST="$PLUGIN_LIVE.new"
else
    PLUGIN_DEST="$PLUGIN_LIVE"
fi
CFG_DEST="$SERVER_DIR/addons/ktpamx/configs/hud_observer.cfg"
PLUGINS_INI="$SERVER_DIR/addons/ktpamx/configs/plugins.ini"
DODSERVER_CFG="$SERVER_DIR/dodserver.cfg"

# No `debug` flag. AMXX's ConfigureDebug clears AMX_FLAG_JITC *globally* the
# moment any plugin is loaded with it, so one debug entry disables the JIT across
# the entire plugin surface on that server — not just ours. This script targets
# production game servers; the dev/prod split keeps `debug` in
# config/local/plugins.ini instead (see CLAUDE.md).
#
# It used to be "KTPHudObserver.amxx debug", which is how ATL1/DEN5/NY1 ended up
# carrying it from their original --bootstrap runs. Cleaned off those three on
# 2026-08-23, the same day the HUD was enabled fleet-wide — had this default
# still been in place, that rollout would have taken the JIT down on 19 more
# public servers.
PLUGINS_INI_LINE="KTPHudObserver.amxx"
DODSERVER_EXEC_LINE="exec addons/ktpamx/configs/hud_observer.cfg"

echo "==> Target: $HOST :: $INSTANCE_DIR"
echo "==> Plugin: $PLUGIN_FILE  ($(wc -c <"$PLUGIN_FILE") bytes)"
[[ "$DO_STAGE" == 1 ]]     && echo "==> Mode: stage (.new — activates at next restart / nightly 3 AM swap)"
[[ "$DO_BOOTSTRAP" == 1 ]] && echo "==> Mode: bootstrap (full install)"
[[ "$DO_CFG" == 1 ]]       && echo "==> Will push hud_observer.cfg"
[[ "$DO_RESTART" == 0 && "$DO_STAGE" == 0 ]] && echo "==> Skipping LGSM restart"

run_remote() {
    if [[ "$DRY_RUN" == 1 ]]; then
        echo "DRY: ssh $HOST -- $*"
    else
        ssh "$HOST" "$@"
    fi
}

run_scp() {
    local src="$1" dst="$2"
    if [[ "$DRY_RUN" == 1 ]]; then
        echo "DRY: scp $src $HOST:$dst"
    else
        scp "$src" "$HOST:$dst"
    fi
}

# ── 1. Stage plugin (and cfg, if requested) into /tmp on the remote ──────────
TMP_PLUGIN="/tmp/KTPHudObserver.amxx.$$"
TMP_CFG="/tmp/hud_observer.cfg.$$"

run_scp "$PLUGIN_FILE" "$TMP_PLUGIN"
[[ "$DO_CFG" == 1 ]] && run_scp "$CFG_FILE" "$TMP_CFG"

# ── 2. Move into place + chown ───────────────────────────────────────────────
run_remote "sudo install -o $LGSM_USER -g $LGSM_USER -m 0644 $TMP_PLUGIN $PLUGIN_DEST && rm -f $TMP_PLUGIN"
if [[ "$DO_CFG" == 1 ]]; then
    run_remote "sudo install -o $LGSM_USER -g $LGSM_USER -m 0644 $TMP_CFG $CFG_DEST && rm -f $TMP_CFG"
fi

# ── 3. Idempotent edits to plugins.ini + dodserver.cfg (bootstrap only) ──────
#
# Both edits use the same pattern: grep first, append only if missing, and
# guarantee a leading newline if the target file doesn't end in one. The
# newline guard exists because we hit a real bug on CHI1/DAL1 where
# plugins.ini's last line had no trailing \n, so `echo 'X' >> file` produced
# `KTPGrenadeDamage.amxxKTPHudObserver.amxx` as a single line — silently
# breaking BOTH plugins.
#
# plugins.ini can't use the exact-match test the exec line does. A server
# bootstrapped before 2026-08-23 carries `KTPHudObserver.amxx debug`, which is
# not string-equal to the flagless line we write now — an -Fx test would call it
# missing and append a SECOND entry, loading the plugin twice. So that file is
# matched on the plugin name regardless of flags, and an existing debug entry is
# rewritten in place rather than duplicated.
#
# The rewrite goes through a temp file + `install` that restores the original
# owner. `sed -i` renames a ROOT-owned temp into place, and LGSM then aborts
# every restart with "Ownership issues found" — before stopping anything, so the
# restart silently does nothing at all.
if [[ "$DO_BOOTSTRAP" == 1 ]]; then
    run_remote "sudo bash -c '
        set -e

        # -- plugins.ini: match on plugin name, strip any debug flag --
        ini=\"$PLUGINS_INI\"
        if grep -qE \"^[[:space:]]*KTPHudObserver\\.amxx([[:space:]]|\$)\" \"\$ini\"; then
            if grep -qE \"^[[:space:]]*KTPHudObserver\\.amxx[[:space:]]+debug[[:space:]]*\\r?\$\" \"\$ini\"; then
                own=\$(stat -c \"%U:%G\" \"\$ini\")
                tmp=\$(mktemp)
                # [[:blank:]] (space/tab) for the trailing run, NOT [[:space:]] —
                # that class includes \\r and would eat the CR before the capture
                # group could preserve it, silently converting the line to LF in
                # a CRLF file. Several hosts ship plugins.ini as CRLF.
                sed \"s/^\\([[:space:]]*KTPHudObserver\\.amxx\\)[[:space:]]\\+debug[[:blank:]]*\\(\\r\\?\\)\$/\\1\\2/\" \"\$ini\" > \"\$tmp\"
                install -o \"\${own%%:*}\" -g \"\${own##*:}\" -m 0644 \"\$tmp\" \"\$ini\"
                rm -f \"\$tmp\"
                echo \"  stripped debug flag  →  \$ini\"
            else
                echo \"  present: KTPHudObserver.amxx  →  \$ini\"
            fi
        else
            if [ -s \"\$ini\" ] && [ \"\$(tail -c1 \"\$ini\")\" != \"\" ]; then
                echo \"\" >> \"\$ini\"
            fi
            echo \"$PLUGINS_INI_LINE\" >> \"\$ini\"
            echo \"  added: $PLUGINS_INI_LINE  →  \$ini\"
        fi

        # -- dodserver.cfg: exact-match is correct here, the line has no variants --
        cfg=\"$DODSERVER_CFG\"
        if ! grep -qFx \"$DODSERVER_EXEC_LINE\" \"\$cfg\"; then
            if [ -s \"\$cfg\" ] && [ \"\$(tail -c1 \"\$cfg\")\" != \"\" ]; then
                echo \"\" >> \"\$cfg\"
            fi
            echo \"$DODSERVER_EXEC_LINE\" >> \"\$cfg\"
            echo \"  added: $DODSERVER_EXEC_LINE  →  \$cfg\"
        else
            echo \"  present: $DODSERVER_EXEC_LINE  →  \$cfg\"
        fi
    '"
fi

# ── 4. LGSM restart ──────────────────────────────────────────────────────────
#
# The LGSM control script is named dodserver, dodserver2, … inside
# $INSTANCE_DIR — auto-discover it. Single-match is required (multi-match
# means $INSTANCE_DIR isn't a single instance dir, which is a usage bug).
if [[ "$DO_RESTART" == 1 ]]; then
    echo "==> LGSM restart"
    if [[ "$DRY_RUN" == 1 ]]; then
        echo "DRY: ssh $HOST -- sudo -u $LGSM_USER \$($INSTANCE_DIR/dodserver*) restart"
    else
        # Discover the LGSM script. Glob expansion happens remotely under
        # sudo because cadaver isn't in the dodserver group on most hosts
        # (only DEN5), so a bare `ls` of /home/dodserver/dod-<port>/ returns
        # Permission denied. Wrap in sudo bash -c so the glob expands as
        # root rather than as cadaver.
        LGSM_SCRIPTS=$(ssh "$HOST" "sudo bash -c 'ls -1 $INSTANCE_DIR/dodserver* 2>/dev/null'")
        SCRIPT_COUNT=$(echo "$LGSM_SCRIPTS" | grep -c '^/' || true)
        if [[ "$SCRIPT_COUNT" -eq 0 ]]; then
            echo "error: no LGSM script found at $INSTANCE_DIR/dodserver*" >&2
            echo "       expected one of: dodserver, dodserver2, dodserver3, dodserver4, dodserver5" >&2
            exit 1
        fi
        if [[ "$SCRIPT_COUNT" -gt 1 ]]; then
            echo "error: multiple LGSM scripts found in $INSTANCE_DIR — ambiguous:" >&2
            echo "$LGSM_SCRIPTS" >&2
            exit 1
        fi
        echo "    LGSM script: $LGSM_SCRIPTS"
        ssh "$HOST" "sudo -u $LGSM_USER $LGSM_SCRIPTS restart"
    fi
fi

echo "==> Done."
