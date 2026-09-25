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
printf '{"serverUrl":"%s"}\n' "${API_URL%/}" > /tmp/rc-config/config.json
