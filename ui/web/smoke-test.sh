#!/bin/sh
# Usage: ui/web/smoke-test.sh <image>
# Starts the UI image and checks routing, caching headers and runtime config.
set -eu
IMAGE="$1"
NAME="rc-ui-smoke-$$"
PORT="${SMOKE_PORT:-18089}"
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" >&2 2>/dev/null || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; exit 1; }

# expect_start_failure <description> [docker run args...]
# The container must exit non-zero quickly; exiting 0 or hanging (timeout) is a failure.
expect_start_failure() {
  desc="$1"; shift
  rc=0
  timeout 30 docker run --rm --name "$NAME-neg" "$@" "$IMAGE" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 124 ]; then
    docker rm -f "$NAME-neg" >/dev/null 2>&1 || true
    echo "FAIL: container did not exit within 30s $desc" >&2; exit 1
  fi
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: container started $desc" >&2; exit 1
  fi
}
expect_start_failure "without API_URL"
expect_start_failure "with an invalid API_URL" -e 'API_URL=https://x.example.com/"onload'

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
