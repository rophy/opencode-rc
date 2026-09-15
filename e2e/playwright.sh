#!/bin/bash
set -euo pipefail

# Run Playwright e2e tests against the web UI.
#
# The gateway image already includes the built web UI at /webui.
# This script sets WEBUI_DIR to enable it.
#
# Usage: ./e2e/playwright.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Create a temporary compose override to enable web UI in gateway
OVERRIDE=$(mktemp)
trap "rm -f $OVERRIDE" EXIT
cat > "$OVERRIDE" <<YAML
services:
  gateway:
    environment:
      WEBUI_DIR: /webui
YAML

COMPOSE="docker compose --profile rc -f docker-compose.yml -f $OVERRIDE"

echo "=== Building ==="
$COMPOSE build

echo ""
echo "=== Starting services ==="
$COMPOSE up -d

echo ""
echo "=== Waiting for gateway to be healthy ==="
for i in $(seq 1 30); do
  if $COMPOSE exec -T dev-machine sh -c "curl -sf http://gateway:8080/healthz > /dev/null" 2>/dev/null; then
    echo "Gateway healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: gateway not healthy after 30 attempts"
    $COMPOSE logs gateway | tail -20
    $COMPOSE down
    exit 1
  fi
  sleep 2
done

# Give dev-machine time to establish tunnel and register session
sleep 5

echo ""
echo "=== Running Playwright tests ==="
TEST_EXIT=0
$COMPOSE exec -T dev-machine sh -c "cd /e2e && npx playwright test --config playwright.config.ts" || TEST_EXIT=$?

echo ""
$COMPOSE down

exit $TEST_EXIT
