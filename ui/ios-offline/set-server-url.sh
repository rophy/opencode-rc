#!/bin/sh
# Presets the opencode-rc server in this iOS bundle: replaces the build's placeholder
# (https://rc-placeholder.invalid) with your server's origin in the bundled web UI, including
# the Content-Security-Policy, which then allows connections only to that server.
# Run once, before building in Xcode:  ./set-server-url.sh https://rc.corp.example.com
set -eu
PLACEHOLDER=rc-placeholder.invalid
url=${1:-}
case "$url" in
  https://*|http://*) ;;
  *) echo "usage: $0 https://<host>[:<port>]" >&2; exit 2 ;;
esac
scheme=${url%%://*}
host=${url#*://}
host=${host%/}
case "$host" in
  ""|*/*|*\?*|*\#*|*@*|*" "*) echo "give the server origin only, e.g. https://rc.corp.example.com" >&2; exit 2 ;;
esac
if [ "$scheme" = https ]; then ws=wss; else ws=ws; fi

cd "$(dirname "$0")/App/App/public"
files=$(grep -rl "$PLACEHOLDER" . || true)
if [ -z "$files" ]; then
  echo "placeholder not found: the server is already set; start again from a fresh copy to change it" >&2
  exit 1
fi
for f in $files; do
  # The policy has https://… and wss://…; the app config has https://… only.
  PH="$PLACEHOLDER" SCHEME="$scheme" WS="$ws" HOST="$host" perl -pi -e '
    s{https://\Q$ENV{PH}\E}{$ENV{SCHEME}://$ENV{HOST}}g;
    s{wss://\Q$ENV{PH}\E}{$ENV{WS}://$ENV{HOST}}g;
  ' "$f"
  echo "updated $f"
done
if grep -rq "$PLACEHOLDER" .; then echo "placeholder still present" >&2; exit 1; fi
echo "server set to $scheme://$host"
