#!/bin/sh
# Writes the UI's runtime config from API_URL. The API host is chosen per deployment,
# so one image serves every environment.
set -eu
if [ -z "${API_URL:-}" ]; then
  echo "40-rc-config: API_URL is required" >&2
  exit 1
fi
case "$API_URL" in
  http://*|https://*) ;;
  *) echo "40-rc-config: API_URL must start with http:// or https://" >&2; exit 1 ;;
esac
case "$API_URL" in
  *[!A-Za-z0-9:/._-]*) echo "40-rc-config: API_URL contains unsupported characters" >&2; exit 1 ;;
esac
mkdir -p /tmp/rc-config
api_url="${API_URL%/}"
printf '{"serverUrl":"%s"}\n' "$api_url" > /tmp/rc-config/config.json

# Security headers (included by nginx.conf). connect-src allows only this origin and the
# API origin (http(s) and its WebSocket form), so an injected script cannot send a token elsewhere.
api_origin=$(printf '%s' "$api_url" | sed -E 's#^(https?://[^/]+).*#\1#')
ws_origin=$(printf '%s' "$api_origin" | sed -E 's#^http#ws#')
csp="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: $api_origin $ws_origin; media-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
cat > /tmp/rc-config/security-headers.conf <<EOF
add_header Content-Security-Policy "$csp" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
EOF
