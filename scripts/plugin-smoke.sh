#!/usr/bin/env bash
#
# plugin-smoke.sh — Tier 1 build-time smoke for KTPHudObserver
#
# Reproduces the exact compile invocation from KTPInfrastructure's
# build/plugins/Dockerfile so what passes locally passes Tony's CI.
#
#   ./amxxpc KTPHudObserver.sma \
#     -i./include \
#     -i/build/plugins/KTPHudObserver \
#     -o/output/plugins/KTPHudObserver.amxx
#
# Sources the compiler + includes from KTPInfrastructure/artifacts/latest/.
# Run `make build-amxx` in KTPInfrastructure once if `artifacts/latest/`
# is empty.
#
# Exit codes:
#   0 — clean compile
#   1 — compile failed
#   2 — unexpected warning (anything beyond the known client_disconnect deprecation)
#   3 — environment problem (missing artifacts, no docker, etc.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Locate the sibling KTPInfrastructure checkout.
#
# Inside a git worktree, REPO_ROOT is the WORKTREE root, so plain
# "$REPO_ROOT/../KTPInfrastructure" resolves to .claude/worktrees/KTPInfrastructure,
# which does not exist -- INFRA_ROOT comes out EMPTY and the script reports
# "artifacts missing at /artifacts/latest/..." with a leading slash, pointing at a
# path nobody has. --git-common-dir points at the MAIN checkout's .git in both
# layouts, so the real repo root is its parent and the sibling is found from there.
#
# KTP_INFRA_ROOT overrides both, for a non-sibling layout.
MAIN_ROOT="$(cd "$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd || true)"
INFRA_ROOT="${KTP_INFRA_ROOT:-}"
if [ -z "$INFRA_ROOT" ]; then
    for candidate in "$REPO_ROOT/../KTPInfrastructure" "$MAIN_ROOT/../KTPInfrastructure"; do
        if [ -d "$candidate" ]; then
            INFRA_ROOT="$(cd "$candidate" && pwd)"
            break
        fi
    done
fi
ARTIFACTS="$INFRA_ROOT/artifacts/latest/ktpamx/scripting"
SMA="$REPO_ROOT/KTPHudObserver.sma"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

if [ ! -f "$SMA" ]; then
    red "ERROR: $SMA not found"
    exit 3
fi
if [ ! -d "$ARTIFACTS/include" ] || [ ! -f "$ARTIFACTS/amxxpc" ]; then
    red "ERROR: KTPAMXX artifacts missing at $ARTIFACTS"
    red "  Run: cd $INFRA_ROOT && make build-amxx"
    exit 3
fi
if ! command -v docker >/dev/null 2>&1; then
    red "ERROR: docker not on PATH"
    exit 3
fi

STAGE="$(mktemp -d -t ktp-plugin-smoke-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/compiler" "$STAGE/build/plugins/KTPHudObserver" "$STAGE/output/plugins"
cp "$ARTIFACTS/amxxpc" "$STAGE/compiler/amxxpc"
cp "$ARTIFACTS/amxxpc32.so" "$STAGE/compiler/amxxpc32.so"
cp -r "$ARTIFACTS/include" "$STAGE/compiler/include"
cp "$SMA" "$STAGE/build/plugins/KTPHudObserver/KTPHudObserver.sma"

# Docker on Windows needs native paths (d:/...), not MSYS (/d/...).
# `pwd -W` emits Windows-style on MSYS; falls through on Linux.
STAGE_WIN="$(cd "$STAGE" && (pwd -W 2>/dev/null || pwd))"

LOG="$STAGE/compile.log"
set +e
docker run --rm \
    -v "$STAGE_WIN:/ci" \
    --entrypoint sh \
    jives/hlds:dod -c '
        set -e
        cp /ci/compiler/amxxpc /tmp/amxxpc
        cp /ci/compiler/amxxpc32.so /tmp/amxxpc32.so
        cp -r /ci/compiler/include /tmp/include
        cp /ci/build/plugins/KTPHudObserver/KTPHudObserver.sma /tmp/src.sma
        cd /tmp
        chmod +x amxxpc
        sed "s/\r$//" src.sma > KTPHudObserver.sma
        ./amxxpc KTPHudObserver.sma \
            -i./include \
            -i/ci/build/plugins/KTPHudObserver \
            -o/ci/output/plugins/KTPHudObserver.amxx 2>&1
    ' >"$LOG"
RC=$?
set -e

cat "$LOG"

if [ "$RC" -ne 0 ] || [ ! -s "$STAGE/output/plugins/KTPHudObserver.amxx" ]; then
    red "FAIL: amxxpc exit=$RC, no .amxx produced"
    exit 1
fi

# Filter expected warnings. The only known-allowed warning is the
# client_disconnect deprecation — DODX still fires it and the replacement
# (client_disconnected) isn't always available across module versions.
WARN_TOTAL="$(grep -cE '^.*\(.*\) : warning' "$LOG" || true)"
WARN_UNEXPECTED="$(grep -E '^.*\(.*\) : warning' "$LOG" \
    | grep -v 'client_disconnect.*deprecated' \
    || true)"

SIZE="$(wc -c <"$STAGE/output/plugins/KTPHudObserver.amxx")"

if [ -n "$WARN_UNEXPECTED" ]; then
    yellow "Unexpected warnings (only client_disconnect deprecation is allowed):"
    printf '%s\n' "$WARN_UNEXPECTED"
    red "FAIL: $WARN_TOTAL warning(s), $(printf '%s\n' "$WARN_UNEXPECTED" | wc -l) unexpected"
    exit 2
fi

green "PASS: KTPHudObserver.amxx built clean (${SIZE} bytes, ${WARN_TOTAL} expected warning(s))"
