#!/bin/sh
# Makes a self-contained iOS bundle: the synced Xcode project (ui/ios after the UI build and
# `npx cap sync ios`) with capacitor-swift-pm included as a local package, so Xcode builds it
# with no internet. Presets and the shipped files come from this script's repository, so it
# can bundle a project checked out at another commit.
#   ui/ios-offline/bundle.sh <synced ui/ios dir> <preset> <out-dir>
# <preset> is "default" (built with no config) or config/presets/<preset>.json.
# Writes <out-dir>/opencode-rc-ios-<version>-<preset>.tgz and its .sha256.
set -eu
PLACEHOLDER=https://rc-placeholder.invalid
fail() { echo "bundle.sh: $*" >&2; exit 1; }

ios=${1:-}; preset=${2:-}; out=${3:-}
if [ -z "$ios" ] || [ -z "$preset" ] || [ -z "$out" ]; then
  echo "usage: $0 <synced ui/ios dir> <preset> <out-dir>" >&2; exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
ios=$(cd "$ios" && pwd)

config=""
if [ "$preset" != default ]; then
  config="$root/config/presets/$preset.json"
  [ -f "$config" ] || { echo "no preset: $config" >&2; exit 2; }
fi
[ -d "$ios/App/App/public" ] || fail "$ios/App/App/public is missing: build the UI and run npx cap sync ios first"

# The synced web UI must be this preset's build: a placeholder server in both or in neither.
placeholder=no
if [ -n "$config" ] && grep -q "\"serverUrl\": *\"$PLACEHOLDER\"" "$config"; then placeholder=yes; fi
built=no
if grep -rq "rc-placeholder.invalid" "$ios/App/App/public"; then built=yes; fi
[ "$placeholder" = "$built" ] || fail "the synced web UI does not match preset $preset (placeholder server: preset $placeholder, build $built)"

pbx="$ios/App/App.xcodeproj/project.pbxproj"
marketing=$(sed -n 's/.*MARKETING_VERSION = \(.*\);/\1/p' "$pbx" | head -1 | tr -d ' ')
build=$(sed -n 's/.*CURRENT_PROJECT_VERSION = \(.*\);/\1/p' "$pbx" | head -1 | tr -d ' ')
[ -n "$marketing" ] && [ -n "$build" ] || fail "no version in $pbx"
version="$marketing-$build"
name="opencode-rc-ios-$version-$preset"

mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dest="$work/$name"

rsync -a \
  --exclude /.gitignore --exclude /README.md \
  --exclude xcuserdata/ --exclude '*.xcworkspace' --exclude .DS_Store \
  --exclude .build/ --exclude .swiftpm/ --exclude /App/build/ --exclude /App/DerivedData/ \
  "$ios/" "$dest/"

# capacitor-swift-pm: one exact-version dependency, two binary targets, nothing else.
spm="$dest/App/CapApp-SPM/Package.swift"
[ "$(grep -c '\.package(' "$spm")" = 1 ] || fail "expected one dependency in App/CapApp-SPM/Package.swift"
capver=$(sed -n 's|.*\.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "\([0-9.]*\)").*|\1|p' "$spm")
[ -n "$capver" ] || fail "App/CapApp-SPM/Package.swift does not depend on capacitor-swift-pm by exact version"
raw="https://raw.githubusercontent.com/ionic-team/capacitor-swift-pm/$capver"
cap="$dest/capacitor-swift-pm"
mkdir "$cap"
curl -fsSL "$raw/Package.swift" -o "$work/upstream.swift"
curl -fsSL "$raw/LICENSE.md" -o "$cap/LICENSE.md"
flat=$(tr -d ' \t\n' < "$work/upstream.swift")
[ "$(printf %s "$flat" | grep -o '\.binaryTarget(' | wc -l | tr -d ' ')" = 2 ] || fail "capacitor-swift-pm $capver: expected two binary targets"
case "$flat" in *'.target('*|*'.executableTarget('*) fail "capacitor-swift-pm $capver: has source targets" ;; esac
for t in Capacitor Cordova; do
  url=$(printf %s "$flat" | sed -n "s|.*\.binaryTarget(name:\"$t\",url:\"\([^\"]*\)\",checksum:\"[0-9a-f]*\").*|\1|p")
  sum=$(printf %s "$flat" | sed -n "s|.*\.binaryTarget(name:\"$t\",url:\"[^\"]*\",checksum:\"\([0-9a-f]*\)\").*|\1|p")
  [ -n "$url" ] && [ -n "$sum" ] || fail "capacitor-swift-pm $capver: no binary target $t"
  curl -fsSL "$url" -o "$work/$t.zip"
  got=$(shasum -a 256 "$work/$t.zip" | cut -d' ' -f1)
  [ "$got" = "$sum" ] || fail "$t.xcframework.zip: checksum $got, expected $sum"
  (cd "$cap" && unzip -q "$work/$t.zip")
  [ -d "$cap/$t.xcframework" ] || fail "$t.zip has no $t.xcframework"
done
cat > "$cap/Package.swift" <<EOF
// swift-tools-version:5.3

import PackageDescription

// capacitor-swift-pm $capver with its two binary targets as local frameworks (the release
// zips, unzipped), so the app builds with no internet.
let package = Package(
    name: "capacitor-swift-pm",
    products: [
        .library(name: "Capacitor", targets: ["Capacitor"]),
        .library(name: "Cordova", targets: ["Cordova"])
    ],
    dependencies: [],
    targets: [
        .binaryTarget(name: "Capacitor", path: "Capacitor.xcframework"),
        .binaryTarget(name: "Cordova", path: "Cordova.xcframework")
    ]
)
EOF
perl -pi -e 's{\.package\(url: "https://github\.com/ionic-team/capacitor-swift-pm\.git", exact: "[0-9.]+"\)}{.package(path: "../../capacitor-swift-pm")}' "$spm"
grep -q '\.package(path: "\.\./\.\./capacitor-swift-pm")' "$spm" || fail "could not point App/CapApp-SPM at the local package"

cp "$root/LICENSE" "$dest/LICENSE"
[ -z "$config" ] || cp "$config" "$dest/config.json"
cp "$here/set-server-url.sh" "$dest/set-server-url.sh"

{
  echo "# OpenCode RC iOS $marketing ($build), preset $preset"
  echo
  echo "Xcode project for the OpenCode RC iOS app with everything it needs to build without"
  echo "internet: the web UI is built in (\`App/App/public\`) and Capacitor $capver is included"
  echo "(\`capacitor-swift-pm/\`, MIT, see its \`LICENSE.md\`). Keep the folder layout as it is."
  echo
  if [ -n "$config" ]; then
    echo "Built with \`config.json\` (in this folder). The app only hides disabled features: disable"
    echo "the same ones in the API's config (chart value \`config\`), which rejects them."
  else
    echo "Generic build: users enter the server in the app, and all features are on."
  fi
  echo
  echo "## 1. Set the server and bundle identifier"
  echo
  if [ "$placeholder" = yes ]; then
    echo "    ./set-server-url.sh --bundle-id com.corp.opencode https://rc.corp.example.com"
    echo
    echo "Give the origin of your opencode-rc API (scheme, host, optional port; no path). The script"
    echo "replaces the placeholder in \`App/App/public\`, including the Content-Security-Policy, which"
    echo "then allows connections only to that server. The server can be set once: to change it later,"
    echo "start again from a fresh copy of this bundle."
  else
    echo "    ./set-server-url.sh --bundle-id com.corp.opencode"
    echo
    echo "Users enter the server in the app, so this bundle takes no server URL."
  fi
  echo
  echo "\`--bundle-id\` (optional) sets the app's bundle identifier, \`com.opencode.rc\` by default; the"
  echo "UI tests get \`<id>.uitests\`. It can be run again to change it."
  echo
  echo "## 2. Build"
  echo
  echo "1. Open \`App/App.xcodeproj\` in Xcode."
  echo "2. To try it, choose an iOS Simulator as the run destination and press Run. The Simulator"
  echo "   needs no signing team, but needs an iOS Simulator runtime installed."
  echo "3. For devices: target **App** > **Signing & Capabilities**, set your team, then"
  echo "   **Product > Archive** and **Distribute App**."
  echo
  echo "The app signs in through its own sheet (not Safari), so a per-app VPN carries the sign-in. Its"
  echo "callback is \`com.opencode.rc:/auth/done\` whatever the bundle identifier."
} > "$dest/README.md"

(cd "$work" && COPYFILE_DISABLE=1 tar czf "$out/$name.tgz" "$name")
(cd "$out" && shasum -a 256 "$name.tgz" > "$name.tgz.sha256")
echo "$out/$name.tgz"
