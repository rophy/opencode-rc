#!/bin/bash
set -euo pipefail

# Wait for OIDC mock
until curl -sf "${OIDC_URL}/.well-known/openid-configuration" >/dev/null 2>&1; do sleep 1; done

# Obtain token from OIDC mock via PKCE
CODE_VERIFIER=$(openssl rand -base64 48 | tr -d '=/+\n' | head -c 43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -e | tr '+/' '-_' | tr -d '=')

AUTH_CODE_URL=$(curl -sf -o /dev/null -w "%{redirect_url}" -X POST \
  -d "sub=${OIDC_USER_SUB:-user1}&client_id=${OIDC_CLIENT_ID}&redirect_uri=http://127.0.0.1:0/callback&state=docker&nonce=test&scope=openid+email+profile&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256" \
  "${OIDC_URL}/authorize/callback")
AUTH_CODE=$(echo "$AUTH_CODE_URL" | sed -n 's/.*code=\([^&]*\).*/\1/p')

TOKEN_RESP=$(curl -sf -X POST "${OIDC_URL}/token" \
  -d "grant_type=authorization_code&client_id=${OIDC_CLIENT_ID}&code=${AUTH_CODE}&redirect_uri=http://127.0.0.1:0/callback&code_verifier=${CODE_VERIFIER}")
ID_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.id_token')

if [ -z "$ID_TOKEN" ] || [ "$ID_TOKEN" = "null" ]; then
  echo "Failed to obtain token from OIDC mock"
  exit 1
fi

export OPENCODE_RC_TOKEN="$ID_TOKEN"
exec "$@"
