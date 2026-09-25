#!/bin/sh
# Usage: ui/web/smoke-test.sh <image>
# Starts the UI image and checks routing, caching headers and runtime config.
set -eu
IMAGE="$1"
NAME="rc-ui-smoke-$$"
PORT="${SMOKE_PORT:-18089}"
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" >&2 2>/dev/null || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; exit 1; }

# Missing API_URL must fail the container start.
if docker run --rm "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: container started without API_URL" >&2; exit 1
fi
# Invalid API_URL must fail too.
if docker run --rm -e 'API_URL=https://x.example.com/"onload' "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: container started with an invalid API_URL" >&2; exit 1
fi

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -e API_URL=https://api.example.com/ "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done

B="http://127.0.0.1:$PORT"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/healthz")" = 200 ] || fail "/healthz"
curl -s "$B/config.json" | grep -qx '{"serverUrl":"https://api.example.com"}' || fail "/config.json content"
curl -sI "$B/config.json" | grep -qi '^cache-control: no-cache' || fail "/config.json cache-control"
curl -s "$B/" | grep -q '<div id="root"' || fail "/ is not index.html"
curl -s "$B/s/alice-dev/abc/session/ses_1" | grep -q '<div id="root"' || fail "SPA fallback"
curl -sI "$B/" | grep -qi '^cache-control: no-cache' || fail "index cache-control"
ASSET=$(curl -s "$B/" | grep -o '/assets/[^"]*\.js' | head -1)
[ -n "$ASSET" ] || fail "no asset referenced from index.html"
curl -sI "$B$ASSET" | grep -qi '^cache-control: public, max-age=31536000, immutable' || fail "asset cache-control"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/assets/nope.js")" = 404 ] || fail "missing asset should 404"
echo "UI image smoke test passed"
