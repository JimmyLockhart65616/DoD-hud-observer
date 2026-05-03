#!/usr/bin/env bash
# Pre-push hook for DoD-hud-observer.
#
# This repo ships a runtime AMXX plugin (KTPHudObserver.amxx) that loads on
# every KTP DoD server, plus a Node backend + React frontend that run on
# the data server. Breaks land on production fast, so the hook gates pushes
# with three checks (cheap-to-expensive, fail-loud-first):
#
#   1. amxxcurl async-lifetime lint (awk) — catches the slist-UAF and
#      sync-cleanup-after-perform anti-patterns documented in
#      KTPAmxxCurl/README.md (the bug class that crashed NY1 2026-04-26).
#
#   2. Docker amxxpc compile of KTPHudObserver.sma — confirms the plugin
#      still compiles against current KTPInfrastructure artifacts. Catches
#      API-breaking changes from upstream KTPAMXX / dodx.
#
#   3. Backend Jest suite (npm run test) — full ingest -> recorder -> disk
#      -> REST round-trip. Catches schema drift and handler regressions.
#
# Requires KTPInfrastructure checked out as a sibling directory (same
# requirement as KTPAMXX's pre-push hook).
#
# Install with: scripts/install-hooks.sh
# Bypass once  : git push --no-verify
# Disable      : export KTP_SKIP_PREPUSH=1
set -euo pipefail

if [[ "${KTP_SKIP_PREPUSH:-0}" == "1" ]]; then
  echo "[pre-push] KTP_SKIP_PREPUSH=1 — skipping checks"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
INFRA_DIR="$REPO_ROOT/../KTPInfrastructure"

# ============================================================
# Stage 1/3: amxxcurl async-lifetime lint
# ============================================================
echo "[pre-push] stage 1/3: amxxcurl lint"

files=$(git ls-files | grep -E '\.(sma|inc)$' || true)

if [[ -n "$files" ]]; then
  fail=0
  for f in $files; do
    [ -f "$f" ] || continue
    awk -v file="$f" '
        /^[[:space:]]*(public|stock)[[:space:]]+[A-Za-z_]/ {
            fn=$0
        }
        /curl_easy_cleanup\(/ {
            if (fn !~ /(complete|callback|plugin_end|cleanup_handle)/) {
                printf("ERROR: %s:%d curl_easy_cleanup outside *_complete/*_callback/plugin_end:\n  %s\n  -> enclosing fn: %s\n  -> rationale: amxxcurl perform is async; sync cleanup races libcurl callback dispatch.\n",
                       file, NR, $0, fn) > "/dev/stderr"
                exit 1
            }
        }
        /curl_slist_free_all\(\s*g_[A-Za-z_0-9]+/ {
            if (fn !~ /plugin_end/) {
                printf("ERROR: %s:%d curl_slist_free_all on a g_* global outside plugin_end:\n  %s\n  -> enclosing fn: %s\n  -> rationale: CURLOPT_HTTPHEADER stores slist by reference; freeing while POSTs are in flight = UAF (see KTPAmxxCurl commit 7e1ce00).\n",
                       file, NR, $0, fn) > "/dev/stderr"
                exit 1
            }
        }
    ' "$f" || fail=1
  done

  if [[ $fail -ne 0 ]]; then
    echo "" >&2
    echo "[pre-push] LINT FAILED — see errors above." >&2
    echo "[pre-push] Bypass with --no-verify (and document why in the commit message)." >&2
    exit 1
  fi
fi

echo "[pre-push] stage 1/3: lint OK"

# ============================================================
# Stage 2/3: Docker amxxpc compile (mirrors CLAUDE.md compile snippet)
# ============================================================
if [[ ! -d "$INFRA_DIR" ]]; then
  echo "[pre-push] KTPInfrastructure not found at $INFRA_DIR" >&2
  echo "[pre-push] Clone it as a sibling dir, or bypass with --no-verify" >&2
  exit 1
fi

VERSION="prepush-$(date +%Y%m%d-%H%M%S)"
echo "[pre-push] stage 2/3: amxxpc compile (VERSION=$VERSION)"
echo "[pre-push] (bypass with --no-verify or KTP_SKIP_PREPUSH=1)"

COMPILE_LOG="$(mktemp -t prepush-compile.XXXXXX.log)"
trap 'rm -f "$COMPILE_LOG" "$TEST_LOG"' EXIT
TEST_LOG="$(mktemp -t prepush-test.XXXXXX.log)"

if ! docker run --rm --entrypoint sh \
  -v "$REPO_ROOT:/src" \
  -v "$INFRA_DIR:/infra" \
  jives/hlds:dod -c '
    set -e
    mkdir -p /tmp/compile/include
    cp /infra/artifacts/latest/ktpamx/scripting/include/*.inc /tmp/compile/include/
    cp /infra/artifacts/latest/ktpamx/scripting/amxxpc /tmp/compile/
    cp /infra/artifacts/latest/ktpamx/scripting/amxxpc32.so /tmp/compile/
    cat /src/KTPHudObserver.sma | tr -d "\r" > /tmp/compile/KTPHudObserver.sma
    cd /tmp/compile
    chmod +x amxxpc
    ./amxxpc KTPHudObserver.sma -oKTPHudObserver.amxx
  ' >"$COMPILE_LOG" 2>&1; then
  echo "[pre-push] AMXXPC COMPILE FAILED — push aborted." >&2
  cat "$COMPILE_LOG" >&2
  exit 1
fi

echo "[pre-push] stage 2/3: compile OK"

# ============================================================
# Stage 3/3: Backend Jest suite
# ============================================================
echo "[pre-push] stage 3/3: backend tests (npm run test)"

cd "$REPO_ROOT"
if ! npm run test --silent >"$TEST_LOG" 2>&1; then
  echo "[pre-push] BACKEND TESTS FAILED — push aborted." >&2
  tail -60 "$TEST_LOG" >&2
  exit 1
fi

echo "[pre-push] stage 3/3: tests OK"
echo "[pre-push] all checks passed"
