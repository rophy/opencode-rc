#!/bin/bash
set -euo pipefail

# Defaults for running against local docker compose (gateway-expose on port 8080)
GATEWAY_URL="${GATEWAY_URL:-http://localhost:9080}"
OIDC_URL="${OIDC_URL:-http://localhost:9081}"
DEV_MACHINE_URL="${DEV_MACHINE_URL:-http://localhost:9082}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-opencode-rc}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-opencode-rc-secret}"

# When running from the host, Docker-internal URLs in redirects need rewriting
rewrite_url() {
  echo "$1" | sed \
    -e "s|http://oidc-mock:8080|${OIDC_URL}|g" \
    -e "s|http://gateway:8080|${GATEWAY_URL}|g" \
    -e "s|http://dev-machine:4096|${DEV_MACHINE_URL}|g"
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

# Wait for all services
wait_for "oidc-mock" "$OIDC_URL/.well-known/openid-configuration" 30
wait_for "gateway" "$GATEWAY_URL/healthz" 30
wait_for "dev-machine" "$DEV_MACHINE_URL/api/health" 60
echo ""

# ------------------------------------------------------------------
# 1. Gateway health check
# ------------------------------------------------------------------
echo "--- Test: Gateway health ---"
HEALTH=$(curl -sf "$GATEWAY_URL/healthz" || true)
if [ "$HEALTH" = "ok" ]; then
  pass "gateway /healthz returns ok"
else
  fail "gateway /healthz: got '$HEALTH'"
fi

# ------------------------------------------------------------------
# 2. Dev machine health check (direct, not through gateway)
# ------------------------------------------------------------------
echo "--- Test: Dev machine health (direct) ---"
DEV_HEALTH=$(curl -sf "$DEV_MACHINE_URL/api/health" || true)
if echo "$DEV_HEALTH" | jq -e . >/dev/null 2>&1; then
  pass "dev-machine /api/health returns JSON"
else
  fail "dev-machine /api/health: got '$DEV_HEALTH'"
fi

# ------------------------------------------------------------------
# 3. OIDC login flow — get a session cookie
# ------------------------------------------------------------------
echo "--- Test: Browser OIDC login ---"
COOKIE_JAR=/tmp/cookies.txt
rm -f "$COOKIE_JAR"

# Verify login page is served (not auto-redirect)
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
# Extract the redirect_uri the gateway registered with the OIDC provider
OIDC_REDIRECT_URI=$(echo "$REDIRECT_URL" | sed -n 's/.*redirect_uri=\([^&]*\).*/\1/p' | python3 -c "import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))")
CALLBACK_URL=$(curl -sf -o /dev/null -w "%{redirect_url}" -X POST \
  -d "sub=user1&client_id=${OIDC_CLIENT_ID}&redirect_uri=${OIDC_REDIRECT_URI}&state=${STATE}&nonce=&scope=openid+email+profile&code_challenge=&code_challenge_method=" \
  "${OIDC_URL}/authorize/callback")
CALLBACK_URL=$(rewrite_url "$CALLBACK_URL")

# Follow callback to gateway
HTTP_CODE=$(curl -sf -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /dev/null -w "%{http_code}" "$CALLBACK_URL" || true)
if [ "$HTTP_CODE" = "302" ]; then
  pass "OIDC callback sets session cookie"
else
  fail "OIDC callback: expected 302, got $HTTP_CODE"
fi

# Verify we can access the dashboard
DASH_CODE=$(curl -sf -b "$COOKIE_JAR" -o /dev/null -w "%{http_code}" "$GATEWAY_URL/" || true)
if [ "$DASH_CODE" = "200" ]; then
  pass "dashboard accessible with session cookie"
else
  fail "dashboard: expected 200, got $DASH_CODE"
fi

# ------------------------------------------------------------------
# 4. CLI registration — get a token and register dev-machine
# ------------------------------------------------------------------
echo "--- Test: CLI registration ---"

# Get a token from oidc-mock using PKCE (public client, no secret)
CLI_CLIENT_ID="${OIDC_CLI_CLIENT_ID:-opencode-rc-cli}"
CLI_REDIRECT_URI="http://127.0.0.1:0/callback"
CODE_VERIFIER=$(openssl rand -base64 48 | tr -d '=/+\n' | head -c 43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -e | tr '+/' '-_' | tr -d '=')

AUTH_CODE_URL=$(curl -sf -o /dev/null -w "%{redirect_url}" -X POST \
  -d "sub=user1&client_id=${CLI_CLIENT_ID}&redirect_uri=${CLI_REDIRECT_URI}&state=clitest&nonce=&scope=openid+email+profile&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256" \
  "${OIDC_URL}/authorize/callback")
AUTH_CODE=$(echo "$AUTH_CODE_URL" | sed -n 's/.*code=\([^&]*\).*/\1/p')

TOKEN_RESP=$(curl -sf -X POST "${OIDC_URL}/token" \
  -d "grant_type=authorization_code&client_id=${CLI_CLIENT_ID}&code=${AUTH_CODE}&redirect_uri=${CLI_REDIRECT_URI}&code_verifier=${CODE_VERIFIER}")
ID_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.id_token')

if [ -n "$ID_TOKEN" ] && [ "$ID_TOKEN" != "null" ]; then
  pass "obtained ID token from OIDC provider"
else
  fail "failed to get ID token: $TOKEN_RESP"
fi

# Register dev-machine with gateway
# Use Docker-internal endpoint so the gateway can proxy to it
SESSION_ID="e2e-test-session"
DEV_MACHINE_INTERNAL="${DEV_MACHINE_INTERNAL:-http://dev-machine:4096}"
REG_RESP=$(curl -sf -X POST "$GATEWAY_URL/gateway/register" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"endpoint\":\"$DEV_MACHINE_INTERNAL\",\"directory\":\"/project\"}" || true)

if echo "$REG_RESP" | jq -e '.status == "registered"' >/dev/null 2>&1; then
  pass "session registered with gateway"
else
  fail "registration failed: $REG_RESP"
fi

# ------------------------------------------------------------------
# 5. Verify session appears in dashboard
# ------------------------------------------------------------------
echo "--- Test: Session in dashboard ---"
SESSIONS=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/gateway/sessions" || true)
SESSION_COUNT=$(echo "$SESSIONS" | jq 'length' 2>/dev/null || echo 0)
if [ "$SESSION_COUNT" -ge 1 ]; then
  pass "session visible in dashboard ($SESSION_COUNT sessions)"
else
  fail "no sessions in dashboard: $SESSIONS"
fi

# ------------------------------------------------------------------
# 6. Proxy: hit dev-machine through gateway
# ------------------------------------------------------------------
echo "--- Test: Proxy to dev-machine ---"
PROXY_HEALTH=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/s/$SESSION_ID/api/health" || true)
if echo "$PROXY_HEALTH" | jq -e . >/dev/null 2>&1; then
  pass "proxied /api/health through gateway"
else
  fail "proxy /api/health: got '$PROXY_HEALTH'"
fi

# ------------------------------------------------------------------
# 7. Heartbeat
# ------------------------------------------------------------------
echo "--- Test: Heartbeat ---"
HB_RESP=$(curl -sf -X POST "$GATEWAY_URL/gateway/heartbeat" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\"}" || true)
if echo "$HB_RESP" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  pass "heartbeat accepted"
else
  fail "heartbeat failed: $HB_RESP"
fi

# ------------------------------------------------------------------
# 8. Deregister
# ------------------------------------------------------------------
echo "--- Test: Deregister ---"
DEREG_RESP=$(curl -sf -X POST "$GATEWAY_URL/gateway/deregister" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\"}" || true)
if echo "$DEREG_RESP" | jq -e '.status == "deregistered"' >/dev/null 2>&1; then
  pass "session deregistered"
else
  fail "deregister failed: $DEREG_RESP"
fi

# Verify our test session is gone (other sessions like rc-client's may still exist)
SESSIONS_AFTER=$(curl -sf -b "$COOKIE_JAR" "$GATEWAY_URL/gateway/sessions" || true)
TEST_SESSION_AFTER=$(echo "$SESSIONS_AFTER" | jq "[.[] | select(.id == \"$SESSION_ID\")] | length" 2>/dev/null || echo 1)
if [ "$TEST_SESSION_AFTER" -eq 0 ]; then
  pass "session removed after deregister"
else
  fail "session still present after deregister: $SESSIONS_AFTER"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
