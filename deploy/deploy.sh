#!/usr/bin/env bash
#
# Deploy DoD HUD Observer backend + frontend to the data server.
#
# Uses tar-over-ssh (no rsync required — Git Bash on Windows doesn't ship it).
#
# Usage:
#   ./deploy/deploy.sh                # deploy both
#   ./deploy/deploy.sh --backend      # backend only (skip web build)
#   ./deploy/deploy.sh --frontend     # frontend only (skip backend restart)
#   ./deploy/deploy.sh --no-build     # skip frontend build step (use existing web/build)
#   ./deploy/deploy.sh --dry-run      # print planned actions, do nothing
#
# Overrides:
#   DEPLOY_HOST=cadaver@74.91.112.242
#   DEPLOY_DIR=/opt/hud-observer
#   DEPLOY_SERVICE=hud-observer
#   DEPLOY_WEB_SERVICE=hud-observer-web
#
# First-time setup on the data server: see deploy/README.md

set -euo pipefail

HOST="${DEPLOY_HOST:-cadaver@74.91.112.242}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/hud-observer}"
SERVICE="${DEPLOY_SERVICE:-hud-observer}"
WEB_SERVICE="${DEPLOY_WEB_SERVICE:-hud-observer-web}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DO_BACKEND=1
DO_FRONTEND=1
DO_BUILD=1
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --backend)   DO_FRONTEND=0 ;;
        --frontend)  DO_BACKEND=0 ;;
        --no-build)  DO_BUILD=0 ;;
        --dry-run)   DRY_RUN=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 1 ;;
    esac
done

run() {
    if [[ "$DRY_RUN" == 1 ]]; then
        echo "DRY: $*"
    else
        "$@"
    fi
}

echo "==> Deploy target: $HOST:$REMOTE_DIR"
echo "==> Services: backend=$SERVICE, web=$WEB_SERVICE"

# Frontend env vars are injected inline so they win over any web/.env.local
# file (CRA loads .env.local in every mode except test — it silently overrides
# .env.production during build and bakes localhost URLs into the bundle).
WEB_API_URL="${REACT_APP_API_URL:-http://74.91.112.242:3001}"
WEB_SOCKET_URL="${REACT_APP_SOCKET_URL:-http://74.91.112.242:4000}"

if [[ "$DO_FRONTEND" == 1 && "$DO_BUILD" == 1 ]]; then
    echo "==> Building frontend (web/build)"
    echo "    REACT_APP_API_URL=$WEB_API_URL"
    echo "    REACT_APP_SOCKET_URL=$WEB_SOCKET_URL"
    run bash -c "cd web && npm ci && REACT_APP_API_URL='$WEB_API_URL' REACT_APP_SOCKET_URL='$WEB_SOCKET_URL' npm run build"
fi

run ssh "$HOST" "mkdir -p $REMOTE_DIR/web"

if [[ "$DO_BACKEND" == 1 ]]; then
    echo "==> Packing + streaming backend source + root package files"
    # Pack repo-root files (package.json, package-lock.json, config.yaml) + backend/
    # Exclude node_modules and tests. On the remote we DON'T delete backend/ first
    # because node_modules lives under it after npm ci — we only replace the source.
    if [[ "$DRY_RUN" == 1 ]]; then
        echo "DRY: tar -c backend package.json package-lock.json config.yaml | ssh $HOST ..."
    else
        tar -c \
            --exclude='backend/node_modules' \
            --exclude='backend/src/__tests__' \
            --exclude='backend/jest.config.js' \
            backend package.json package-lock.json config.yaml \
            | ssh "$HOST" "cd $REMOTE_DIR && rm -rf backend && tar -x"
    fi
fi

if [[ "$DO_FRONTEND" == 1 ]]; then
    echo "==> Packing + streaming web/build"
    if [[ "$DRY_RUN" == 1 ]]; then
        echo "DRY: tar -c -C web build | ssh $HOST ..."
    else
        tar -c -C web build \
            | ssh "$HOST" "cd $REMOTE_DIR/web && rm -rf build && tar -x"
    fi
fi

if [[ "$DO_BACKEND" == 1 ]]; then
    echo "==> Installing backend deps (npm ci --legacy-peer-deps)"
    # --legacy-peer-deps because the root package.json still carries the old
    # react-bootstrap dep from the CS fork; npm 8+ flags its peer conflict with
    # modern react. Cleanup is out of scope for deploy tooling.
    run ssh "$HOST" "cd $REMOTE_DIR && npm ci --legacy-peer-deps"
fi

if [[ "$DRY_RUN" == 1 ]]; then
    echo "==> Dry run complete, no remote changes"
    exit 0
fi

if [[ "$DO_BACKEND" == 1 ]]; then
    if ssh "$HOST" "systemctl list-unit-files $SERVICE.service --no-legend 2>/dev/null | grep -q ." ; then
        echo "==> Restarting $SERVICE"
        ssh "$HOST" "sudo systemctl restart $SERVICE"
        ssh "$HOST" "sudo systemctl status $SERVICE --no-pager -l | head -15"
    else
        echo "==> $SERVICE unit not installed yet — skipping restart (first deploy)"
    fi
fi

if [[ "$DO_FRONTEND" == 1 ]]; then
    if ssh "$HOST" "systemctl list-unit-files $WEB_SERVICE.service --no-legend 2>/dev/null | grep -q ." ; then
        echo "==> Restarting $WEB_SERVICE"
        ssh "$HOST" "sudo systemctl restart $WEB_SERVICE"
        ssh "$HOST" "sudo systemctl status $WEB_SERVICE --no-pager -l | head -10"
    else
        echo "==> $WEB_SERVICE unit not installed yet — skipping restart (first deploy)"
    fi
fi

echo "==> Done."
