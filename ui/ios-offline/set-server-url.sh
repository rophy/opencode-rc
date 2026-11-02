#!/bin/sh
# Presets the opencode-rc server in this iOS bundle: replaces the build's placeholder
# (https://rc-placeholder.invalid) with your server's origin in the bundled web UI, including
# the Content-Security-Policy, which then allows connections only to that server.
# --bundle-id sets the app's bundle identifier (the test targets get <id>.tests and <id>.uitests).
# Run before building in Xcode:
#   ./set-server-url.sh [--bundle-id com.corp.opencode] https://rc.corp.example.com
#   ./set-server-url.sh --bundle-id com.corp.opencode     (bundle id only)
# The server can be set once; the bundle id can be set again.
set -eu
PLACEHOLDER=rc-placeholder.invalid
usage() { echo "usage: $0 [--bundle-id <id>] [https://<host>[:<port>]]" >&2; exit 2; }
url=
bundle_id=
set_bundle_id=no
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle-id) [ $# -ge 2 ] || usage; bundle_id=$2; set_bundle_id=yes; shift 2 ;;
    -*) usage ;;
    *) [ -z "$url" ] || usage; url=$1; shift ;;
  esac
done
[ -n "$url" ] || [ "$set_bundle_id" = yes ] || usage

if [ "$set_bundle_id" = yes ]; then
  # Apple allows letters, digits, "-" and "." in reverse-DNS form.
  case "$bundle_id" in
    # The test targets take <id>.tests and <id>.uitests, so an id of that form would be read back as theirs.
    ""|*[!A-Za-z0-9.-]*|.*|*.|*..*|*.uitests|*.tests) bundle_id_ok=no ;;
    *.*) bundle_id_ok=yes ;;
    *) bundle_id_ok=no ;;
  esac
  if [ "$bundle_id_ok" = no ]; then
    echo "bad bundle id '$bundle_id': use letters, digits, '-' and '.', e.g. com.corp.opencode" >&2
    exit 2
  fi
fi
if [ -n "$url" ]; then
  case "$url" in
    https://*|http://*) ;;
    *) usage ;;
  esac
  scheme=${url%%://*}
  host=${url#*://}
  host=${host%/}
  case "$host" in
    ""|*/*|*\?*|*\#*|*@*|*" "*) echo "give the server origin only, e.g. https://rc.corp.example.com" >&2; exit 2 ;;
  esac
  if [ "$scheme" = https ]; then ws=wss; else ws=ws; fi
fi

cd "$(dirname "$0")/App"
pbx=App.xcodeproj/project.pbxproj

# Check everything before changing anything.
if [ -n "$url" ]; then
  files=$(cd App/public && grep -rl "$PLACEHOLDER" . || true)
  if [ -z "$files" ]; then
    echo "placeholder not found: the server is already set, or this bundle lets users enter it; start again from a fresh copy to change it" >&2
    exit 1
  fi
fi
if [ "$set_bundle_id" = yes ]; then
  grep -q 'PRODUCT_BUNDLE_IDENTIFIER = ' "$pbx" || { echo "no bundle identifier in $pbx" >&2; exit 1; }
fi

if [ "$set_bundle_id" = yes ]; then
  ID="$bundle_id" perl -pi -e '
    s{PRODUCT_BUNDLE_IDENTIFIER = "?([^";]*)"?;}{
      "PRODUCT_BUNDLE_IDENTIFIER = \"" . ($1 =~ /(\.uitests|\.tests)$/ ? "$ENV{ID}$1" : $ENV{ID}) . "\";"
    }ge;
  ' "$pbx"
  echo "bundle id set to $bundle_id"
fi

if [ -n "$url" ]; then
  cd App/public
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
fi
