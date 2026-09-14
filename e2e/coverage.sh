#!/bin/bash
set -euo pipefail

# Run e2e tests with coverage collection for gateway (Go), tunneler (Go), and CLI (Node).
#
# Usage: ./e2e/coverage.sh
#
# Prerequisites: docker compose
# Output: .cover/gateway.out, .cover/tunneler.out, .cover/cli/ (V8 coverage JSON)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

export COVER=true

COVER_DIR="$PROJECT_DIR/.cover"

# .cover/ files are root-owned (created by Docker containers), use a container to clean
docker run --rm -v "$PROJECT_DIR:/work" alpine sh -c \
  "rm -rf /work/.cover && mkdir -p /work/.cover/gateway /work/.cover/tunneler /work/.cover/cli && chown -R $(id -u):$(id -g) /work/.cover"

echo "=== Building with coverage instrumentation ==="
docker compose --profile rc build gateway tunneler dev-machine

echo ""
echo "=== Starting services ==="
docker compose --profile rc up -d

echo ""
echo "=== Waiting for gateway to be healthy ==="
for i in $(seq 1 30); do
  if docker compose --profile rc exec -T dev-machine sh -c "curl -sf http://gateway:8080/healthz > /dev/null" 2>/dev/null; then
    echo "Gateway healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: gateway not healthy after 30 attempts"
    docker compose --profile rc logs gateway | tail -20
    docker compose --profile rc down
    exit 1
  fi
  sleep 2
done

echo ""
echo "=== Running e2e tests ==="
TEST_EXIT=0
docker compose --profile rc \
  exec -T dev-machine sh -c "cd /e2e && npx vitest run" || TEST_EXIT=$?

echo ""
echo "=== Stopping services (graceful for coverage flush) ==="
docker compose --profile rc stop -t 10

echo ""
echo "=== Collecting coverage ==="

# Fix permissions on coverage files (created as root by containers)
docker run --rm -v "$COVER_DIR:/cover" alpine chown -R "$(id -u):$(id -g)" /cover

# Gateway (Go): convert binary coverage to textfmt
if ls "$COVER_DIR/gateway/cov"* 2>/dev/null; then
  echo "Gateway coverage data found."
  if command -v go >/dev/null 2>&1; then
    (cd "$PROJECT_DIR/backend" && go tool covdata textfmt -i="$COVER_DIR/gateway" -o="$COVER_DIR/gateway.out") && {
      echo ""
      echo "--- Gateway coverage ---"
      (cd "$PROJECT_DIR/backend" && go tool cover -func="$COVER_DIR/gateway.out" | tail -1)
      echo "Full report: cd backend && go tool cover -func=$COVER_DIR/gateway.out"
      echo "HTML report: cd backend && go tool cover -html=$COVER_DIR/gateway.out -o=$COVER_DIR/gateway.html"
    } || echo "Warning: could not convert gateway coverage (go tool covdata failed)"
  else
    echo "Warning: go not found, cannot convert gateway coverage"
  fi
else
  echo "Warning: no gateway coverage data found in $COVER_DIR/gateway/"
  ls -la "$COVER_DIR/gateway/" 2>/dev/null || true
fi

# Tunneler (Go): convert binary coverage to textfmt
if ls "$COVER_DIR/tunneler/cov"* 2>/dev/null; then
  echo "Tunneler coverage data found."
  if command -v go >/dev/null 2>&1; then
    (cd "$PROJECT_DIR/backend" && go tool covdata textfmt -i="$COVER_DIR/tunneler" -o="$COVER_DIR/tunneler.out") && {
      echo ""
      echo "--- Tunneler coverage ---"
      (cd "$PROJECT_DIR/backend" && go tool cover -func="$COVER_DIR/tunneler.out" | tail -1)
      echo "Full report: cd backend && go tool cover -func=$COVER_DIR/tunneler.out"
      echo "HTML report: cd backend && go tool cover -html=$COVER_DIR/tunneler.out -o=$COVER_DIR/tunneler.html"
    } || echo "Warning: could not convert tunneler coverage (go tool covdata failed)"
  else
    echo "Warning: go not found, cannot convert tunneler coverage"
  fi
else
  echo "Warning: no tunneler coverage data found in $COVER_DIR/tunneler/"
  ls -la "$COVER_DIR/tunneler/" 2>/dev/null || true
fi

# CLI (Node): rewrite container paths and report using c8
if ls "$COVER_DIR/cli/"*.json 2>/dev/null; then
  echo ""
  echo "--- CLI coverage ---"

  # V8 coverage references container paths (file:///cli/...).
  # Rewrite to host paths so c8 can find source maps and source files.
  REWRITTEN_DIR="$COVER_DIR/cli-rewritten"
  mkdir -p "$REWRITTEN_DIR"
  for f in "$COVER_DIR/cli/"*.json; do
    sed "s|file:///cli/|file://$PROJECT_DIR/cli/|g" "$f" > "$REWRITTEN_DIR/$(basename "$f")"
  done

  if command -v npx >/dev/null 2>&1; then
    cd "$PROJECT_DIR/cli"
    npx c8 report \
      --temp-directory "$REWRITTEN_DIR" \
      --src src/ \
      --reporter text 2>/dev/null || echo "Warning: c8 report failed (install c8: npm i -g c8)"
    cd "$PROJECT_DIR"
  else
    echo "Warning: npx not found, cannot report CLI coverage"
  fi
else
  echo ""
  echo "Warning: no CLI coverage data found in $COVER_DIR/cli/"
fi

echo ""
docker compose --profile rc down

exit $TEST_EXIT
