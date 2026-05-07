#!/usr/bin/env bash
# lint-amxxcurl-async.sh — catch the two amxxcurl async-lifetime anti-patterns
# that crashed NY1 on 2026-04-26 (curl_slist UAF on map change; see
# KTPAmxxCurl commit 7e1ce00).
#
# Patterns flagged:
#   1. curl_easy_cleanup() outside *_complete / *_callback / plugin_end /
#      *cleanup_handle. amxxcurl perform is async; sync cleanup races the
#      libcurl callback dispatch.
#   2. curl_slist_free_all() on a g_* global outside plugin_end.
#      CURLOPT_HTTPHEADER stores the slist by reference; freeing while POSTs
#      are in flight = UAF.
#
# Usage:
#   scripts/lint-amxxcurl-async.sh                       # all tracked .sma/.inc
#   scripts/lint-amxxcurl-async.sh path/foo.sma bar.inc  # explicit files
#
# Exit codes:
#   0 — clean
#   1 — lint failure (see stderr for file:line + rationale)
#   2 — usage / environment problem
#
# Designed to be copied verbatim into other KTP plugin repos
# (KTPMatchHandler, KTPHLTVRecorder, KTPCvarChecker, KTPInfrastructure hooks,
# etc.). No external deps beyond awk + git.
set -euo pipefail

if [[ $# -gt 0 ]]; then
  files=("$@")
else
  if ! command -v git >/dev/null 2>&1; then
    echo "lint-amxxcurl-async: git not found and no files passed" >&2
    exit 2
  fi
  mapfile -t files < <(git ls-files '*.sma' '*.inc' 2>/dev/null || true)
fi

if [[ ${#files[@]} -eq 0 ]]; then
  exit 0
fi

fail=0
for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
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

exit $fail
