#!/bin/bash
set -euo pipefail

# Run e2e tests with coverage collection for both gateway (Go) and CLI (Node).
#
# Usage: ./e2e/coverage.sh
#
# Prerequisites: docker compose
# Output: .cover/gateway.out, .cover/cli/ (V8 coverage JSON)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

COVER_DIR="$PROJECT_DIR/.cover"
rm -rf "$COVER_DIR"
mkdir -p "$COVER_DIR/gateway" "$COVER_DIR/cli"

echo "=== Building with coverage instrumentation ==="
docker compose -f docker-compose.yml -f docker-compose.cover.yml \
  --profile expose --profile rc \
  build --build-arg COVER=true gateway
docker compose -f docker-compose.yml -f docker-compose.cover.yml \
  --profile expose --profile rc \
  build rc-client

echo ""
echo "=== Starting services ==="
docker compose -f docker-compose.yml -f docker-compose.cover.yml \
  --profile expose --profile rc \
  up -d

echo ""
echo "=== Running e2e tests ==="
TEST_EXIT=0
"$SCRIPT_DIR/test.sh" || TEST_EXIT=$?

echo ""
echo "=== Stopping services (graceful for coverage flush) ==="
# SIGTERM lets processes flush coverage data before exit
docker compose -f docker-compose.yml -f docker-compose.cover.yml \
  --profile expose --profile rc \
  stop -t 10

echo ""
echo "=== Collecting coverage ==="

# Gateway (Go): convert binary coverage to textfmt
if ls "$COVER_DIR/gateway/"*.{out,cov} 2>/dev/null || ls "$COVER_DIR/gateway/cov"* 2>/dev/null; then
  echo "Gateway coverage data found."
  # Use go tool covdata to convert to text format
  if command -v go >/dev/null 2>&1; then
    go tool covdata textfmt -i="$COVER_DIR/gateway" -o="$COVER_DIR/gateway.out" 2>/dev/null && {
      echo ""
      echo "--- Gateway coverage ---"
      go tool cover -func="$COVER_DIR/gateway.out" | tail -1
      echo "Full report: go tool cover -func=$COVER_DIR/gateway.out"
      echo "HTML report: go tool cover -html=$COVER_DIR/gateway.out -o=$COVER_DIR/gateway.html"
    } || echo "Warning: could not convert gateway coverage (go tool covdata failed)"
  else
    echo "Warning: go not found, cannot convert gateway coverage"
  fi
else
  echo "Warning: no gateway coverage data found in $COVER_DIR/gateway/"
  echo "  Check that GOCOVERDIR is set and the gateway received SIGTERM."
fi

# CLI (Node): report using c8
if ls "$COVER_DIR/cli/"*.json 2>/dev/null; then
  echo ""
  echo "--- CLI coverage ---"
  if command -v npx >/dev/null 2>&1; then
    cd "$PROJECT_DIR/cli"
    npx c8 report \
      --temp-directory "$COVER_DIR/cli" \
      --src src/ \
      --reporter text 2>/dev/null || echo "Warning: c8 report failed (install c8: npm i -g c8)"
  else
    echo "Warning: npx not found, cannot report CLI coverage"
  fi
else
  echo ""
  echo "Warning: no CLI coverage data found in $COVER_DIR/cli/"
  echo "  Check that NODE_V8_COVERAGE is set and rc-client exited cleanly."
fi

echo ""
docker compose -f docker-compose.yml -f docker-compose.cover.yml \
  --profile expose --profile rc \
  down

exit $TEST_EXIT
