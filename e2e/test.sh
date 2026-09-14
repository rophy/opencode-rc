#!/bin/bash
set -euo pipefail

# Defaults for running against local docker compose
GATEWAY_URL="${GATEWAY_URL:-http://localhost:9080}"
OIDC_URL="${OIDC_URL:-http://localhost:9081}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-opencode-rc}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-opencode-rc-secret}"
SESSION_ID="${OPENCODE_RC_SESSION_ID:-alice-dev}"

# When running from the host, Docker-internal URLs in redirects need rewriting
rewrite_url() {
  echo "$1" | sed \
    -e "s|http://oidc-mock:8080|${OIDC_URL}|g" \
    -e "s|http://gateway:8080|${GATEWAY_URL}|g"
}

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

wait_for() {
  local name="$1" url="$2" max="${3:-60}"
  echo "Waiting for $name ($url)..."
  for i in $(seq 1 "$max"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "  $name ready (${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "  $name not ready after ${max}s"
  return 1
}

echo "=== opencode-rc e2e tests ==="
echo ""

# Wait for services
wait_for "oidc-mock" "$OIDC_URL/.well-known/openid-configuration" 30
wait_for "gateway" "$GATEWAY_URL/healthz" 30

# Tunneler is internal-only; check from inside the Docker network
echo "Waiting for tunneler (via rc-client)..."
for i in $(seq 1 30); do
  if docker compose exec -T rc-client curl -sf http://tunneler:9090/healthz >/dev/null 2>&1; then
    echo "  tunneler ready (${i}s)"
    break
  fi
  sleep 1
done
echo ""

# ------------------------------------------------------------------
# 1. Gateway health check
# ------------------------------------------------------------------
echo "--- Test: Gateway health ---"
HEALTH=$(curl -sf "$GATEWAY_URL/healthz" || true)
if echo "$HEALTH" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  pass "gateway /healthz returns ok"
else
  fail "gateway /healthz: got '$HEALTH'"
fi

TUNNELER_HEALTH=$(docker compose exec -T rc-client curl -sf http://tunneler:9090/healthz 2>/dev/null || true)
if echo "$TUNNELER_HEALTH" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  pass "tunneler /healthz returns ok"
else
  fail "tunneler /healthz: got '$TUNNELER_HEALTH'"
fi

# ------------------------------------------------------------------
# 2. OIDC login flow — get a session cookie
# ------------------------------------------------------------------
echo "--- Test: Browser OIDC login ---"
COOKIE_JAR=/tmp/cookies.txt
rm -f "$COOKIE_JAR"

# Verify login page is served
LOGIN_PAGE=$(curl -sf "$GATEWAY_URL/auth/login" || true)
if echo "$LOGIN_PAGE" | grep -q "Sign in with OIDC"; then
  pass "gateway /auth/login shows login page"
else
  fail "gateway /auth/login: no login page"
fi

REDIRECT_URL=$(curl -sf -c "$COOKIE_JAR" -o /dev/null -w "%{redirect_url}" "$GATEWAY_URL/auth/start")
REDIRECT_URL=$(rewrite_url "$REDIRECT_URL")
STATE=$(echo "$REDIRECT_URL" | sed -n 's/.*state=\([^&]*\).*/\1/p')

if [ -n "$STATE" ]; then
  pass "gateway /auth/start redirects to OIDC with state"
else
  fail "gateway /auth/start: no state in redirect"
fi

# Select user1 (Alice) on oidc-mock
OIDC_REDIRECT_URI=$(echo "$REDIRECT_URL" | sed -n 's/.*redirect_uri=\([^&]*\).*/\1/p' | python3 -c "import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))")
CALLBACK_URL=$(curl -sf -o /dev/null -w "%{redirect_url}" -X POST \
  -d "sub=user1&client_id=${OIDC_CLIENT_ID}&redirect_uri=${OIDC_REDIRECT_URI}&state=${STATE}&nonce=&scope=openid+email+profile&code_challenge=&code_challenge_method=" \
  "${OIDC_URL}/authorize/callback")
CALLBACK_URL=$(rewrite_url "$CALLBACK_URL")

HTTP_CODE=$(curl -sf -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /dev/null -w "%{http_code}" "$CALLBACK_URL" || true)
if [ "$HTTP_CODE" = "302" ]; then
  pass "OIDC callback sets session cookie"
else
  fail "OIDC callback: expected 302, got $HTTP_CODE"
fi

# Verify dashboard is accessible
DASH_CODE=$(curl -sf -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" "$GATEWAY_URL/" || true)
if [ "$DASH_CODE" = "200" ]; then
  pass "dashboard accessible with session cookie"
else
  fail "dashboard: expected 200, got $DASH_CODE"
fi

# ------------------------------------------------------------------
# 3. Wait for rc-client tunnel connection
# ------------------------------------------------------------------
echo "--- Test: Tunnel connection ---"

TUNNEL_READY=false
for i in $(seq 1 60); do
  SESSIONS=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/gateway/sessions" 2>/dev/null || echo "[]")
  SESSION_COUNT=$(echo "$SESSIONS" | jq 'length' 2>/dev/null || echo 0)
  if [ "$SESSION_COUNT" -ge 1 ]; then
    TUNNEL_READY=true
    break
  fi
  sleep 1
done

if [ "$TUNNEL_READY" = "true" ]; then
  pass "rc-client tunnel connected ($SESSION_COUNT sessions, ${i}s)"
else
  fail "rc-client tunnel not connected after 60s"
fi

# ------------------------------------------------------------------
# 4. Verify session appears in dashboard API
# ------------------------------------------------------------------
echo "--- Test: Session in dashboard ---"
SESSIONS=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/gateway/sessions" || true)
SESSION_COUNT=$(echo "$SESSIONS" | jq 'length' 2>/dev/null || echo 0)
if [ "$SESSION_COUNT" -ge 1 ]; then
  pass "session visible in dashboard ($SESSION_COUNT sessions)"
else
  fail "no sessions in dashboard: $SESSIONS"
fi

# Check session has expected fields
HAS_SESSION=$(echo "$SESSIONS" | jq -e "[.[] | select(.id == \"$SESSION_ID\")] | length > 0" 2>/dev/null || echo false)
if [ "$HAS_SESSION" = "true" ]; then
  pass "expected session '$SESSION_ID' found"
else
  fail "session '$SESSION_ID' not in sessions: $SESSIONS"
fi

# ------------------------------------------------------------------
# 5. Proxy: hit opencode through gateway tunnel
# ------------------------------------------------------------------
echo "--- Test: Proxy through tunnel ---"

# Wait for opencode serve to be ready (via tunnel proxy)
PROXY_READY=false
for i in $(seq 1 30); do
  PROXY_HEALTH=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/s/$SESSION_ID/api/health" 2>/dev/null || true)
  if echo "$PROXY_HEALTH" | jq -e . >/dev/null 2>&1; then
    PROXY_READY=true
    break
  fi
  sleep 1
done

if [ "$PROXY_READY" = "true" ]; then
  pass "proxied /api/health through tunnel (${i}s)"
else
  fail "proxy /api/health failed: '$PROXY_HEALTH'"
fi

# ------------------------------------------------------------------
# 6. Proxy: list sessions via opencode API
# ------------------------------------------------------------------
echo "--- Test: Proxy API calls ---"
PROXY_SESSIONS=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/s/$SESSION_ID/api/session" || true)
if echo "$PROXY_SESSIONS" | jq -e . >/dev/null 2>&1; then
  pass "proxied /api/session returns JSON"
else
  fail "proxy /api/session: got '$PROXY_SESSIONS'"
fi

# ------------------------------------------------------------------
# 7. User info API
# ------------------------------------------------------------------
echo "--- Test: User info ---"
ME=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/api/me" || true)
if echo "$ME" | jq -e '.email == "alice@example.com"' >/dev/null 2>&1; then
  pass "/api/me returns user info"
else
  fail "/api/me: got '$ME'"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
