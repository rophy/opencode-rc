#!/bin/sh
# Checks an iOS offline bundle on macOS: the checksum, set-server-url.sh (the server for
# bundles with the placeholder, and the bundle id), a build with no package downloads and an
# unsigned device build.
# Default-preset bundles run the Simulator UI test (AppUITests); bundles with a preset
# server build for the Simulator and check that the app stays running 20 s after launch.
#   ui/ios-offline/verify.sh <bundle.tgz>        (UDID=<simulator> to pick the Simulator)
set -eu
fail() { echo "verify.sh: $*" >&2; exit 1; }
tgz=${1:-}
[ -f "$tgz" ] || { echo "usage: $0 <bundle.tgz>" >&2; exit 2; }
(cd "$(dirname "$tgz")" && shasum -a 256 -c "$(basename "$tgz").sha256")

work=$(mktemp -d)
bundle_id=
booted=no
cleanup() {
  if [ -n "$bundle_id" ]; then
    xcrun simctl terminate "$UDID" "$bundle_id" >/dev/null 2>&1 || true
    xcrun simctl uninstall "$UDID" "$bundle_id" >/dev/null 2>&1 || true
  fi
  [ "$booted" = yes ] && { xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true; }
  rm -rf "$work"
}
trap cleanup EXIT
preset=no
tar xzf "$tgz" -C "$work"
dir=$(find "$work" -mindepth 1 -maxdepth 1 -type d)

[ -f "$dir/set-server-url.sh" ] || fail "no set-server-url.sh"
if grep -rq rc-placeholder.invalid "$dir/App/App/public"; then
  preset=yes
  "$dir/set-server-url.sh" https://rc.example.com
  ! grep -rq rc-placeholder.invalid "$dir/App/App/public" || fail "placeholder left after set-server-url.sh"
  grep -q "https://rc.example.com wss://rc.example.com" "$dir/App/App/public/index.html" || fail "CSP not updated"
  ! "$dir/set-server-url.sh" https://other.example.com 2>/dev/null || fail "set-server-url.sh ran twice"
else
  ! "$dir/set-server-url.sh" https://rc.example.com 2>/dev/null || fail "set-server-url.sh set a server with no placeholder"
fi
# The app and its UI tests build, run and test under another bundle id.
want_id=com.example.rcverify
"$dir/set-server-url.sh" --bundle-id $want_id

if [ -z "${UDID:-}" ]; then
  UDID=$(xcrun simctl list devices available -j \
    | jq -r '[.devices | to_entries[] | select(.key | test("iOS")) | .value[] | select(.name | startswith("iPhone"))][0].udid')
fi
[ -n "$UDID" ] && [ "$UDID" != null ] || fail "no iPhone Simulator available"

cd "$dir/App"
# A new package folder, to see that SwiftPM fetches nothing.
if [ "$preset" = no ]; then
  xcodebuild test -project App.xcodeproj -scheme App -configuration Debug \
    -destination "id=$UDID" -derivedDataPath "$work/dd" -clonedSourcePackagesDirPath "$work/spm" \
    CODE_SIGNING_ALLOWED=NO
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$work/dd/Build/Products/Debug-iphonesimulator/App.app/Info.plist")
  [ "$id" = "$want_id" ] || fail "bundle id $id, expected $want_id"
else
  # AppUITests expect the server settings button, which a preset server hides: launch instead.
  xcodebuild build -project App.xcodeproj -scheme App -configuration Debug \
    -destination "id=$UDID" -derivedDataPath "$work/dd" -clonedSourcePackagesDirPath "$work/spm" \
    CODE_SIGNING_ALLOWED=NO
  app="$work/dd/Build/Products/Debug-iphonesimulator/App.app"
  [ -d "$app" ] || fail "no $app"
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
  [ "$id" = "$want_id" ] || fail "bundle id $id, expected $want_id"
  state_now=$(xcrun simctl list devices -j | jq -r --arg u "$UDID" '[.devices[][] | select(.udid == $u)][0].state')
  if [ "$state_now" != Booted ]; then
    xcrun simctl boot "$UDID"
    booted=yes
  fi
  xcrun simctl bootstatus "$UDID" -b >/dev/null
  xcrun simctl install "$UDID" "$app"
  bundle_id=$id
  # "<bundle id>: <pid>": Simulator apps are host processes, so kill -0 sees whether it lives.
  pid=$(xcrun simctl launch "$UDID" "$bundle_id" | sed -n 's/^[^:]*: *\([0-9][0-9]*\)$/\1/p')
  [ -n "$pid" ] || fail "no process id from simctl launch"
  sleep 20
  kill -0 "$pid" 2>/dev/null || fail "$bundle_id (pid $pid) is not running 20 s after launch"
fi

# The project has no Swift packages: SwiftPM must not have fetched anything.
state="$work/spm/workspace-state.json"
if [ -f "$state" ]; then
  jq -e '(.object.dependencies | length == 0) and (.object.artifacts | length == 0)' "$state" >/dev/null \
    || { cat "$state" >&2; fail "a package or artifact was resolved"; }
fi
[ ! -d "$work/spm/checkouts" ] || fail "SwiftPM fetched packages"

xcodebuild build -project App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination "generic/platform=iOS" \
  -derivedDataPath "$work/dd" -clonedSourcePackagesDirPath "$work/spm" CODE_SIGNING_ALLOWED=NO

echo "verified $(basename "$tgz")"
