#!/bin/sh
# Checks an iOS offline bundle on macOS: the checksum, the server preset (bundles with
# set-server-url.sh), a build with no package downloads, the Simulator launch test
# (AppUITests) and an unsigned device build.
#   ui/ios-offline/verify.sh <bundle.tgz>        (UDID=<simulator> to pick the Simulator)
set -eu
fail() { echo "verify.sh: $*" >&2; exit 1; }
tgz=${1:-}
[ -f "$tgz" ] || { echo "usage: $0 <bundle.tgz>" >&2; exit 2; }
(cd "$(dirname "$tgz")" && shasum -a 256 -c "$(basename "$tgz").sha256")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar xzf "$tgz" -C "$work"
dir=$(find "$work" -mindepth 1 -maxdepth 1 -type d)
[ -d "$dir/capacitor-swift-pm" ] || fail "no capacitor-swift-pm/"

if [ -f "$dir/set-server-url.sh" ]; then
  "$dir/set-server-url.sh" https://rc.example.com
  ! grep -rq rc-placeholder.invalid "$dir/App/App/public" || fail "placeholder left after set-server-url.sh"
  grep -q "https://rc.example.com wss://rc.example.com" "$dir/App/App/public/index.html" || fail "CSP not updated"
  ! "$dir/set-server-url.sh" https://other.example.com 2>/dev/null || fail "set-server-url.sh ran twice"
fi

if [ -z "${UDID:-}" ]; then
  UDID=$(xcrun simctl list devices available -j \
    | jq -r '[.devices | to_entries[] | select(.key | test("iOS")) | .value[] | select(.name | startswith("iPhone"))][0].udid')
fi
[ -n "$UDID" ] && [ "$UDID" != null ] || fail "no iPhone Simulator available"

cd "$dir/App"
# A new package folder: anything SwiftPM would fetch must come from the bundle.
xcodebuild test -project App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$work/dd" -clonedSourcePackagesDirPath "$work/spm" \
  CODE_SIGNING_ALLOWED=NO

state="$work/spm/workspace-state.json"
[ -f "$state" ] || fail "no $state"
jq -e '(.object.dependencies | length > 0)
  and all(.object.dependencies[]; .packageRef.kind == "fileSystem")
  and all(.object.artifacts[]; .source.type == "local")' "$state" >/dev/null \
  || { cat "$state" >&2; fail "a package or artifact is not local"; }

xcodebuild build -project App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination "generic/platform=iOS" \
  -derivedDataPath "$work/dd" -clonedSourcePackagesDirPath "$work/spm" CODE_SIGNING_ALLOWED=NO

echo "verified $(basename "$tgz")"
