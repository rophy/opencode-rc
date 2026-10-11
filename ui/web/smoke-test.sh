#!/bin/sh
# Usage: ui/web/smoke-test.sh <image>
# Starts the UI image and checks routing, caching and security headers.
set -eu
IMAGE="$1"
NAME="rc-ui-smoke-$$"
PORT="${SMOKE_PORT:-18089}"
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" >&2 2>/dev/null || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; exit 1; }

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done

B="http://127.0.0.1:$PORT"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/healthz")" = 200 ] || fail "/healthz"
# No runtime config: the generic image's SPA fallback answers /config.json with index.html.
curl -s "$B/config.json" | grep -q '<div id="root"' || fail "/config.json should not be served"
curl -s "$B/" | grep -q '<div id="root"' || fail "/ is not index.html"
curl -s "$B/s/alice-dev/abc/session/ses_1" | grep -q '<div id="root"' || fail "SPA fallback"
curl -sI "$B/" | grep -qi '^cache-control: no-cache' || fail "index cache-control"
ASSET=$(curl -s "$B/" | grep -o '/assets/[^"]*\.js' | head -1)
[ -n "$ASSET" ] || fail "no asset referenced from index.html"
curl -sI "$B$ASSET" | grep -qi '^cache-control: public, max-age=31536000, immutable' || fail "asset cache-control"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/assets/nope.js")" = 404 ] || fail "missing asset should 404"
# The 2.x build is served under /v2/ with its own index and assets.
curl -s "$B/v2/" | grep -q '/v2/assets/' || fail "/v2/ is not the 2.x index.html"
curl -s "$B/v2/s/x/" | grep -q '/v2/assets/' || fail "/v2/s/x/ SPA fallback"
curl -sI "$B/v2/" | grep -qi '^cache-control: no-cache' || fail "v2 index cache-control"
ASSET2=$(curl -s "$B/v2/" | grep -o '/v2/assets/[^"]*\.js' | head -1)
[ -n "$ASSET2" ] || fail "no asset referenced from v2 index.html"
curl -sI "$B$ASSET2" | grep -qi '^cache-control: public, max-age=31536000, immutable' || fail "v2 asset cache-control"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/v2/assets/nope.js")" = 404 ] || fail "missing v2 asset should 404"
CSP=$(curl -sI "$B/" | grep -i '^content-security-policy:' || true)
echo "$CSP" | grep -q "connect-src 'self' data: http: https: ws: wss:;" || fail "CSP connect-src: $CSP"
echo "$CSP" | grep -q "script-src 'self' 'wasm-unsafe-eval';" || fail "CSP script-src: $CSP"
echo "$CSP" | grep -q "frame-ancestors 'none'" || fail "CSP frame-ancestors: $CSP"
curl -sI "$B$ASSET" | grep -qi '^content-security-policy:' || fail "asset CSP"
curl -sI "$B/" | grep -qi '^x-content-type-options: nosniff' || fail "nosniff"
curl -sI "$B/" | grep -qi '^referrer-policy: no-referrer' || fail "referrer-policy"
curl -s "$B/" | grep -q '<script src="/theme.js"></script>' || fail "theme.js not referenced"
curl -s "$B/" | grep -q '<script>' && fail "inline script in index.html"
# Every asset a stylesheet references must exist (fonts from opencode's public folder once went missing).
for css in $(curl -s "$B/" | grep -o '/assets/[^"]*\.css'); do
  for u in $(curl -s "$B$css" | grep -o 'url([^)]*)' | sed -E "s/url\([\"']?([^\"')]*)[\"']?\)/\1/" | grep '^/assets/' | sort -u); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$B$u")" = 200 ] || fail "$css references missing $u"
  done
done
echo "UI image smoke test passed"
