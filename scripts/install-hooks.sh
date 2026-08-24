#!/usr/bin/env bash
# Install git hooks for this repo. Idempotent — safe to re-run.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# `git rev-parse --git-path hooks`, not "$REPO_ROOT/.git/hooks".
#
# Inside a git worktree, .git is a FILE pointing at the main checkout's
# .git/worktrees/<name>, so the literal path fails with "Not a directory" and the
# hook never gets installed. --git-path resolves correctly in both layouts and
# also honours core.hooksPath if it is ever set.
#
# Hooks live in the COMMON git dir, so installing from any worktree installs for
# every worktree — which is what we want: the checks gate pushes, not checkouts.
HOOKS_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DIR"

install -m 0755 "$REPO_ROOT/scripts/pre-push.sh" "$HOOKS_DIR/pre-push"
echo "installed: $HOOKS_DIR/pre-push"
