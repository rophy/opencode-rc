# iOS Offline Bundle Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI publishes, per iOS release and preset, a GHCR image holding a self-contained Xcode project that builds offline, and stops pushing `releases/ios`.

**Architecture:** Shell scripts in `ui/ios-offline/` make the bundle (`bundle.sh`), check it on macOS (`verify.sh`) and preset the server (`set-server-url.sh`, shipped in the bundle). A reusable workflow, `ios-offline.yml`, builds the app source at an `ios/<version>` tag with the tools from the workflow's own commit, verifies each bundle on macOS and pushes a busybox image from Linux. `ios.yml` calls it for a new version.

**Tech Stack:** POSIX sh + perl, rsync, curl, shasum, unzip, xcodebuild, jq; GitHub Actions; vitest (Node 22) for the preset and script tests.

**Spec:** `docs/superpowers/specs/2026-10-22-ios-offline-bundle-design.md`

## Global Constraints

- Image: `ghcr.io/rophy/opencode-rc/ios:<version>-<preset>` (`<version>` = `MARKETING_VERSION-CURRENT_PROJECT_VERSION`, e.g. `1.4-5`); busybox; `/bundle/opencode-rc-ios-<version>-<preset>.tgz` and `.tgz.sha256`; command lists `/bundle`.
- Presets: `default` (no config file) and `all-off` (`config/presets/all-off.json`).
- Placeholder server: `https://rc-placeholder.invalid`.
- A published image tag is never overwritten.
- Bundles hold no deployment-specific data; committed text names no private hosts, no `.local/` paths, no Claude/attribution.
- Non-goals: signing, prebuilt `.app`, runtime server file, Android, version bumps.
- Commits: `<type>: <description>`, GPG-signed (default), no attribution lines. No push without the user saying so.
- Before push: `make unit-test`, and the UI tests on Node 22 (`cd ui && npx -y node@22 node_modules/vitest/vitest.mjs run`).
- `$SCRATCH` in the steps is a scratch directory outside the repo (e.g. the session scratchpad). `$MAC` is the ssh target of a Mac with Xcode, and `$SIM_UDID` an iPhone Simulator on it; the person running the plan supplies both (never commit them).

**Rulings against the spec (recorded):**
- Scripts live in `ui/ios-offline/` (spec: `ui/build/ios-offline-bundle.sh`): `ui/build/` holds the TypeScript build tooling; the bundle scripts, the shipped script and the Dockerfile belong together.
- Zip checksums use `shasum -a 256` (spec: `swift package compute-checksum`): SwiftPM's binary-target checksum is the SHA-256 of the zip, and `shasum` also runs on Linux.
- `bundle.sh` takes the synced `ui/ios` directory as an argument: the workflow builds the app at an older tag that has no `ui/ios-offline/` or `config/presets/`, so the tools and presets come from the workflow's commit.
- The macOS job cannot run Docker; a Linux job pushes the image from the verified tarball.

---

## File Structure

| File | Responsibility |
|---|---|
| `config/presets/all-off.json` (create) | The `all-off` preset |
| `ui/ios-offline/presets.test.ts` (create) | Presets validate and `all-off` disables every feature |
| `ui/ios-offline/set-server-url.sh` (create) | Shipped in placeholder bundles; replaces the placeholder |
| `ui/ios-offline/set-server-url.test.ts` (create) | Runs the script on a fixture |
| `ui/ios-offline/bundle.sh` (create) | Synced `ui/ios` → offline bundle tarball |
| `ui/ios-offline/verify.sh` (create) | macOS checks of a tarball |
| `ui/ios-offline/Dockerfile` (create) | Busybox image holding a tarball |
| `.github/workflows/ios-offline.yml` (create) | Plan → bundle (macOS) → publish (Linux) |
| `.github/workflows/ios.yml` (modify) | Drop `releases/ios`, call `ios-offline.yml` |
| `ui/ios/README.md`, `docs/ios-app.md`, `.claude/skills/check-versions.md` (modify) | Docs |

---

### Task 1: `all-off` preset

**Files:**
- Create: `config/presets/all-off.json`
- Test: `ui/ios-offline/presets.test.ts`

**Interfaces:**
- Consumes: `FEATURES`, `FEATURES_V2`, `parseConfig` from `config/schema.ts`.
- Produces: `config/presets/all-off.json` (used by Tasks 3 and 5 as `config/presets/<preset>.json`).

- [ ] **Step 1: Write the failing test** — `ui/ios-offline/presets.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { FEATURES, FEATURES_V2, parseConfig } from "../../config/schema.ts"

const preset = (name: string) =>
  JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../config/presets/${name}.json`, import.meta.url)), "utf8"))

describe("iOS offline bundle presets", () => {
  it("all-off validates, uses the placeholder server and disables every feature", () => {
    const config = parseConfig(preset("all-off"), "all-off.json")
    expect(config.serverUrl).toBe("https://rc-placeholder.invalid")
    for (const name of FEATURES) expect(config.features[name].enabled, `features.${name}`).toBe(false)
    for (const name of FEATURES_V2) expect(config.opencodeV2.features[name].enabled, `opencodeV2.features.${name}`).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (ENOENT on `all-off.json`):
`cd ui && npx vitest run ios-offline/presets.test.ts`

- [ ] **Step 3: Create `config/presets/all-off.json`:**

```json
{
  "serverUrl": "https://rc-placeholder.invalid",
  "features": {
    "uploads": { "enabled": false },
    "downloads": { "enabled": false },
    "terminal": { "enabled": false },
    "shell": { "enabled": false },
    "export": { "enabled": false },
    "share": { "enabled": false },
    "config": { "enabled": false },
    "mcp": { "enabled": false }
  },
  "opencodeV2": {
    "features": {
      "uploads": { "enabled": false },
      "downloads": { "enabled": false },
      "terminal": { "enabled": false },
      "shell": { "enabled": false },
      "export": { "enabled": false },
      "mcp": { "enabled": false }
    }
  }
}
```

If `parseConfig`'s returned shape differs from `config.features[name].enabled` / `config.opencodeV2.features[name].enabled`, read `RcConfig` in `config/schema.ts` and adapt the test's accessors, not the preset.

- [ ] **Step 4: Run it, expect PASS.** Also remove one entry from the JSON temporarily and check the test fails naming it; restore.

- [ ] **Step 5: Commit**

```bash
git add config/presets/all-off.json ui/ios-offline/presets.test.ts
git commit -m "feat: all-off build preset for the iOS offline bundle"
```

---

### Task 2: `set-server-url.sh`

**Files:**
- Create: `ui/ios-offline/set-server-url.sh` (mode 755)
- Test: `ui/ios-offline/set-server-url.test.ts`

**Interfaces:**
- Produces: a script that, placed at a bundle's root, rewrites `App/App/public`. Usage `./set-server-url.sh <http(s)://host[:port]>`; exit 2 on bad input, 1 when no placeholder is left. Task 3 copies it into the bundle; Task 4 runs it.

- [ ] **Step 1: Write the failing test** — `ui/ios-offline/set-server-url.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./set-server-url.sh", import.meta.url))
const CSP = `default-src 'self'; connect-src 'self' data: https://rc-placeholder.invalid wss://rc-placeholder.invalid; object-src 'none'`

let root: string
const pub = (...p: string[]) => path.join(root, "App", "App", "public", ...p)
const run = (url: string) => spawnSync("sh", [path.join(root, "set-server-url.sh"), url], { encoding: "utf8" })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-bundle-"))
  fs.mkdirSync(pub("assets"), { recursive: true })
  fs.mkdirSync(pub("v2", "assets"), { recursive: true })
  for (const f of [pub("index.html"), pub("v2", "index.html")])
    fs.writeFileSync(f, `<meta http-equiv="Content-Security-Policy" content="${CSP.replaceAll("'", "&#39;")}">`)
  for (const f of [pub("assets", "index-a.js"), pub("v2", "assets", "index-b.js")])
    fs.writeFileSync(f, `const c={serverUrl:\`https://rc-placeholder.invalid\`,features:{}}`)
  fs.writeFileSync(pub("assets", "other.js"), "const x=1")
  fs.copyFileSync(script, path.join(root, "set-server-url.sh"))
})

describe("set-server-url.sh", () => {
  it("sets an https server in the config and the CSP", () => {
    const r = run("https://rc.example.com:8443")
    expect(r.status, r.stderr).toBe(0)
    const html = fs.readFileSync(pub("index.html"), "utf8")
    expect(html).toContain("https://rc.example.com:8443 wss://rc.example.com:8443;")
    expect(fs.readFileSync(pub("v2", "assets", "index-b.js"), "utf8")).toContain("`https://rc.example.com:8443`")
    for (const f of [pub("index.html"), pub("v2", "index.html"), pub("assets", "index-a.js"), pub("v2", "assets", "index-b.js")])
      expect(fs.readFileSync(f, "utf8")).not.toContain("rc-placeholder.invalid")
  })

  it("uses ws: for an http server", () => {
    expect(run("http://10.0.0.5:12029").status).toBe(0)
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("http://10.0.0.5:12029 ws://10.0.0.5:12029;")
  })

  it("accepts a trailing slash", () => {
    expect(run("https://rc.example.com/").status).toBe(0)
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("https://rc.example.com wss://rc.example.com;")
  })

  it.each(["", "rc.example.com", "ftp://rc.example.com", "https://rc.example.com/api", "https://rc.example.com?x=1", "https://u@rc.example.com"])(
    "rejects %j and changes nothing",
    (url) => {
      const r = run(url)
      expect(r.status).toBe(2)
      expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("rc-placeholder.invalid")
    },
  )

  it("refuses a second run", () => {
    expect(run("https://rc.example.com").status).toBe(0)
    const r = run("https://other.example.com")
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already set/)
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("https://rc.example.com")
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (script missing): `cd ui && npx vitest run ios-offline/set-server-url.test.ts`

- [ ] **Step 3: Create `ui/ios-offline/set-server-url.sh`** and `chmod 755` it:

```sh
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
```

- [ ] **Step 4: Run it, expect PASS.** Then run on Node 22: `cd ui && npx -y node@22 node_modules/vitest/vitest.mjs run ios-offline/`.

- [ ] **Step 5: Commit**

```bash
git add ui/ios-offline/set-server-url.sh ui/ios-offline/set-server-url.test.ts
git commit -m "feat: set-server-url.sh for iOS offline bundles"
```

---

### Task 3: `bundle.sh`

**Files:**
- Create: `ui/ios-offline/bundle.sh` (mode 755)

**Interfaces:**
- Consumes: `config/presets/<preset>.json` (Task 1), `ui/ios-offline/set-server-url.sh` (Task 2), the repo `LICENSE` — all relative to the script's own repo.
- Produces: `bundle.sh <synced-ios-dir> <preset> <out-dir>` → `<out-dir>/opencode-rc-ios-<version>-<preset>.tgz` and `.tgz.sha256` (format `<sha256>  <file>`); prints the `.tgz` path last. Exit 2 on bad arguments, 1 on any check failure. Task 4 and Task 5 use it.

- [ ] **Step 1: Create `ui/ios-offline/bundle.sh`** and `chmod 755` it:

```sh
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
[ "$placeholder" = no ] || cp "$here/set-server-url.sh" "$dest/set-server-url.sh"

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
  if [ "$placeholder" = yes ]; then
    echo "## 1. Set the server (once)"
    echo
    echo "    ./set-server-url.sh https://rc.corp.example.com"
    echo
    echo "Give the origin of your opencode-rc API (scheme, host, optional port; no path). The script"
    echo "replaces the placeholder in \`App/App/public\`, including the Content-Security-Policy, which"
    echo "then allows connections only to that server. It runs once: to change the server later,"
    echo "start again from a fresh copy of this bundle."
    echo
    echo "## 2. Build"
  else
    echo "## Build"
  fi
  echo
  echo "1. Open \`App/App.xcodeproj\` in Xcode."
  echo "2. To try it, choose an iOS Simulator as the run destination and press Run. The Simulator"
  echo "   needs no signing team, but needs an iOS Simulator runtime installed."
  echo "3. For devices: target **App** > **Signing & Capabilities**, set your team and a bundle"
  echo "   identifier (changing it from \`com.opencode.rc\` is fine), then **Product > Archive** and"
  echo "   **Distribute App**."
  echo
  echo "The app signs in through the system browser and returns on \`com.opencode.rc:/auth/done\`."
} > "$dest/README.md"

(cd "$work" && COPYFILE_DISABLE=1 tar czf "$out/$name.tgz" "$name")
(cd "$out" && shasum -a 256 "$name.tgz" > "$name.tgz.sha256")
echo "$out/$name.tgz"
```

- [ ] **Step 2: Check syntax and lint**

Run: `sh -n ui/ios-offline/bundle.sh && docker run --rm -v "$PWD:/w" -w /w koalaman/shellcheck:stable ui/ios-offline/bundle.sh ui/ios-offline/set-server-url.sh`
Expected: no errors (fix warnings that point at real problems; leave style-only ones).

- [ ] **Step 3: Check the argument errors (Linux is fine)**

Run: `ui/ios-offline/bundle.sh; echo "exit $?"` → usage, `exit 2`.
Run: `ui/ios-offline/bundle.sh ui/ios nosuch /tmp/x; echo "exit $?"` → `no preset`, `exit 2`.

- [ ] **Step 4: Bundle a real synced project, both presets**

The worktree has no built web UI. Use the main checkout's synced `ui/ios`, whose `App/App/public` is an `all-off` build of 61cc3cd (verify with `grep -rl rc-placeholder.invalid <main>/ui/ios/App/App/public`). Run on Linux into the session scratchpad:

```bash
ui/ios-offline/bundle.sh /home/rophy/projects/opencode-rc/ui/ios all-off "$SCRATCH/offline"
ui/ios-offline/bundle.sh /home/rophy/projects/opencode-rc/ui/ios default "$SCRATCH/offline"; echo "exit $?"
```
Expected: the first prints `.../opencode-rc-ios-1.4-5-all-off.tgz`; the second fails with `does not match preset default`, exit 1.
Check the tarball: `tar tzf …all-off.tgz | grep -v '/App/App/public/' | head -40` shows `capacitor-swift-pm/{Package.swift,LICENSE.md,Capacitor.xcframework/,Cordova.xcframework/}`, `set-server-url.sh`, `config.json`, `LICENSE`, `README.md`, and no `.gitignore`. `tar xzf … -O */App/CapApp-SPM/Package.swift | grep package(` shows the `path:` dependency. `sha256sum -c` on the `.sha256` passes.

- [ ] **Step 5: Commit**

```bash
git add ui/ios-offline/bundle.sh
git commit -m "feat: bundle.sh makes a self-contained iOS Xcode project"
```

---

### Task 4: `verify.sh`

**Files:**
- Create: `ui/ios-offline/verify.sh` (mode 755)

**Interfaces:**
- Consumes: a tarball and `.sha256` from Task 3.
- Produces: `verify.sh <bundle.tgz>` on macOS; exit 0 when every check passes. Optional env `UDID` picks the Simulator; default: the first available iPhone. Task 5 runs it.

- [ ] **Step 1: Create `ui/ios-offline/verify.sh`** and `chmod 755` it:

```sh
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
```

- [ ] **Step 2: Lint:** `sh -n ui/ios-offline/verify.sh` and shellcheck as in Task 3.

- [ ] **Step 3: Run it on the Mac against the Task 3 tarball**

```bash
ssh $MAC 'rm -rf ~/rc-offline-test && mkdir ~/rc-offline-test'
scp ui/ios-offline/verify.sh "$SCRATCH"/offline/opencode-rc-ios-1.4-5-all-off.tgz* $MAC:rc-offline-test/
ssh $MAC "cd ~/rc-offline-test && UDID=$SIM_UDID ./verify.sh opencode-rc-ios-1.4-5-all-off.tgz 2>&1 | tail -15"
```
Expected: `** TEST SUCCEEDED **`, `** BUILD SUCCEEDED **`, `verified opencode-rc-ios-1.4-5-all-off.tgz`.

- [ ] **Step 4: Check the check fails when it should** (on the Mac): make a copy of the tarball whose `App/CapApp-SPM/Package.swift` has the original GitHub `url:` dependency (extract, `perl -pi` the line back, re-tar, new `.sha256`), run `verify.sh` on it, expect `a package or artifact is not local` (exit 1). Delete `~/rc-offline-test` after.

- [ ] **Step 5: Commit**

```bash
git add ui/ios-offline/verify.sh
git commit -m "feat: verify.sh checks an iOS offline bundle on macOS"
```

---

### Task 5: Image and workflows

**Files:**
- Create: `ui/ios-offline/Dockerfile`, `.github/workflows/ios-offline.yml`
- Modify: `.github/workflows/ios.yml` (remove steps "Prepare releases/ios" and "Publish to releases/ios"; add job `offline`)

**Interfaces:**
- Consumes: `bundle.sh` (Task 3), `verify.sh` (Task 4), `config/presets/*.json` (Task 1).
- Produces: `ios-offline.yml` with `workflow_call` input `ref` (string, required) and `workflow_dispatch` inputs `ref` (string, default `''` = latest `ios/*` tag) and `preset` (choice `all|default|all-off`).

- [ ] **Step 1: Create `ui/ios-offline/Dockerfile`:**

```dockerfile
# Carries an iOS offline bundle. Extract it with:
#   docker create --name b <image> && docker cp b:/bundle/<bundle>.tgz . && docker rm b
FROM busybox:1.37
ARG BUNDLE
LABEL org.opencontainers.image.source="https://github.com/rophy/opencode-rc" \
      org.opencontainers.image.description="OpenCode RC iOS Xcode project that builds without internet" \
      org.opencontainers.image.licenses="MIT"
COPY ${BUNDLE}.tgz ${BUNDLE}.tgz.sha256 /bundle/
WORKDIR /bundle
CMD ["ls", "-l", "/bundle"]
```

Check locally with the Task 3 tarball: `docker build -f ui/ios-offline/Dockerfile --build-arg BUNDLE=opencode-rc-ios-1.4-5-all-off -t rc-ios-test "$SCRATCH/offline" && docker run --rm rc-ios-test` lists both files; then `docker rmi rc-ios-test`.

- [ ] **Step 2: Create `.github/workflows/ios-offline.yml`:**

```yaml
name: iOS offline bundle

# Publishes ghcr.io/<repo>/ios:<version>-<preset>: the Xcode project of an ios/<version> tag
# with Capacitor included, so it builds without internet. The app source comes from the tag;
# the bundle tools and presets come from this workflow's commit.
on:
  workflow_call:
    inputs:
      ref:
        description: ios/<version> tag to bundle
        type: string
        required: true
  workflow_dispatch:
    inputs:
      ref:
        description: ios/<version> tag to bundle (empty = the latest)
        type: string
        default: ''
      preset:
        description: Preset to bundle
        type: choice
        options: [all, default, all-off]
        default: all

permissions:
  contents: read
  packages: write

jobs:
  # Picks the tag and the presets that have no image yet: a published image is never replaced.
  plan:
    runs-on: ubuntu-latest
    outputs:
      ref: ${{ steps.plan.outputs.ref }}
      version: ${{ steps.plan.outputs.version }}
      presets: ${{ steps.plan.outputs.presets }}
    steps:
      - name: Log in to ghcr.io
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Resolve tag and presets
        id: plan
        env:
          REF: ${{ inputs.ref }}
          PRESET: ${{ inputs.preset || 'all' }}
          REPO: ${{ github.repository }}
        run: |
          if [ -z "$REF" ]; then
            REF=$(git ls-remote --tags --refs "https://github.com/$REPO.git" 'refs/tags/ios/*' \
              | sed 's|.*refs/tags/||' | sort -V | tail -1)
          fi
          case "$REF" in ios/?*) ;; *) echo "not an ios/<version> tag: '$REF'" >&2; exit 1 ;; esac
          VERSION=${REF#ios/}
          if [ "$PRESET" = all ]; then CANDIDATES="default all-off"; else CANDIDATES="$PRESET"; fi
          PRESETS=""
          for p in $CANDIDATES; do
            if docker manifest inspect "ghcr.io/$REPO/ios:$VERSION-$p" > /dev/null 2>&1; then
              echo "ghcr.io/$REPO/ios:$VERSION-$p exists, skipping"
            else
              PRESETS="$PRESETS $p"
            fi
          done
          {
            echo "ref=$REF"
            echo "version=$VERSION"
            echo "presets=$(printf '%s\n' $PRESETS | jq -Rcs 'split("\n") | map(select(length > 0))')"
          } >> "$GITHUB_OUTPUT"

  bundle:
    needs: plan
    if: needs.plan.outputs.presets != '[]'
    runs-on: macos-latest
    strategy:
      fail-fast: false
      matrix:
        preset: ${{ fromJSON(needs.plan.outputs.presets) }}
    steps:
      - name: Check out the tools
        uses: actions/checkout@v5
        with:
          path: tools

      - name: Check out the app at ${{ needs.plan.outputs.ref }}
        uses: actions/checkout@v5
        with:
          ref: ${{ needs.plan.outputs.ref }}
          path: src
          submodules: recursive

      - uses: oven-sh/setup-bun@v2
      # Vite runs on Node; pin it so the build doesn't depend on the runner's default.
      - uses: actions/setup-node@v5
        with:
          node-version: '22'

      - name: Install submodule deps
        run: |
          cd src/vendor/opencode-v1 && bun install --frozen-lockfile
          cd ../opencode-v2 && bun install --frozen-lockfile --ignore-scripts

      - name: Build SPA (${{ matrix.preset }})
        env:
          PRESET: ${{ matrix.preset }}
        run: |
          if [ "$PRESET" != default ]; then export OPENCODE_RC_CONFIG="$GITHUB_WORKSPACE/tools/config/presets/$PRESET.json"; fi
          cd src/ui && bun install --frozen-lockfile && bun run build

      - name: Sync iOS project
        run: cd src/ui && npx cap sync ios

      - name: Bundle
        run: tools/ui/ios-offline/bundle.sh src/ui/ios "${{ matrix.preset }}" out

      - name: Verify
        run: tools/ui/ios-offline/verify.sh "out/opencode-rc-ios-${{ needs.plan.outputs.version }}-${{ matrix.preset }}.tgz"

      - uses: actions/upload-artifact@v4
        with:
          name: ios-${{ needs.plan.outputs.version }}-${{ matrix.preset }}
          path: out/
          if-no-files-found: error
          retention-days: 7

  # macOS runners have no Docker: the image is built from the verified tarball on Linux.
  publish:
    needs: [plan, bundle]
    runs-on: ubuntu-latest
    strategy:
      matrix:
        preset: ${{ fromJSON(needs.plan.outputs.presets) }}
    steps:
      - uses: actions/checkout@v5

      - uses: actions/download-artifact@v4
        with:
          name: ios-${{ needs.plan.outputs.version }}-${{ matrix.preset }}
          path: out

      - name: Check the tarball
        run: cd out && sha256sum -c "opencode-rc-ios-${{ needs.plan.outputs.version }}-${{ matrix.preset }}.tgz.sha256"

      - name: Log in to ghcr.io
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v7
        with:
          context: out
          file: ui/ios-offline/Dockerfile
          build-args: BUNDLE=opencode-rc-ios-${{ needs.plan.outputs.version }}-${{ matrix.preset }}
          push: true
          tags: ghcr.io/${{ github.repository }}/ios:${{ needs.plan.outputs.version }}-${{ matrix.preset }}
```

Note: the `bundle` job verifies the version: `verify.sh` gets the file name built from the tag's version, so a pbxproj version that differs from the tag fails there.

- [ ] **Step 3: Edit `.github/workflows/ios.yml`.** Delete the steps `Prepare releases/ios` and `Publish to releases/ios` (keep `Tag release`). Change the comment above `jobs:`/`version:` if it mentions `releases/ios`. Append the job:

```yaml
  # The offline bundles (ghcr.io/<repo>/ios:<version>-<preset>) for a new version. Called, not
  # triggered by the tag: a tag pushed with GITHUB_TOKEN starts no other workflow.
  offline:
    needs: [version, build]
    if: needs.version.outputs.new == 'true'
    uses: ./.github/workflows/ios-offline.yml
    with:
      ref: ios/${{ needs.version.outputs.version }}
    permissions:
      contents: read
      packages: write
```

Leave `paths` as it is: `'ui/**'` and `'config/**'` already cover `ui/ios-offline/` and `config/presets/`.

- [ ] **Step 4: Lint the workflows**

Run: `actionlint .github/workflows/ios.yml .github/workflows/ios-offline.yml`
Expected: no output. Then `grep -n "releases/ios" .github/workflows/ios.yml` → nothing.

- [ ] **Step 5: Commit**

```bash
git add ui/ios-offline/Dockerfile .github/workflows/ios-offline.yml .github/workflows/ios.yml
git commit -m "build: publish iOS offline bundle images instead of releases/ios"
```

---

### Task 6: Docs

**Files:**
- Modify: `ui/ios/README.md`, `docs/ios-app.md` (section "Distribution"), `.claude/skills/check-versions.md` (iOS row)

- [ ] **Step 1: Replace `ui/ios/README.md`** (it described the `releases/ios` branch; the bundle now writes its own README):

````markdown
# OpenCode RC — iOS

The Capacitor iOS project. `App/App/public` and `capacitor-cordova-ios-plugins/` are
generated: build the UI (`cd ui && bun run build`) and run `npx cap sync ios` first.

To build the app on a Mac with only Xcode, use a release bundle instead: CI publishes one per
iOS version and preset, with the web UI built in and Capacitor included, so it builds without
internet.

```bash
docker create --name b ghcr.io/rophy/opencode-rc/ios:<version>-<preset>
docker cp b:/bundle/opencode-rc-ios-<version>-<preset>.tgz . && docker rm b
tar xzf opencode-rc-ios-<version>-<preset>.tgz
```

Presets: `default` (users enter the server in the app; all features on) and `all-off` (all
features off; set your server once with the bundle's `set-server-url.sh`). The bundle's
`README.md` has the steps. See `docs/ios-app.md`.
````

- [ ] **Step 2: Rewrite "Distribution" in `docs/ios-app.md`** (from `## Distribution` to before `## Building Locally`):

````markdown
## Distribution

Every push to `main` that touches the app builds it for the iOS Simulator (unsigned) and runs
`AppUITests`, a smoke test that launches the app and checks the bundled UI renders and responds.
Run it locally with `xcodebuild test -project App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=<device>' CODE_SIGNING_ALLOWED=NO`
in `ui/ios/App`, after a build without a preset server and `npx cap sync ios`.

When the push brings a new `MARKETING_VERSION`-`CURRENT_PROJECT_VERSION` (no `ios/<version>`
tag yet), `.github/workflows/ios.yml` tags it `ios/<version>` and calls
`.github/workflows/ios-offline.yml`, which publishes one image per preset:

    ghcr.io/rophy/opencode-rc/ios:<version>-<preset>

Each holds `/bundle/opencode-rc-ios-<version>-<preset>.tgz`: the Xcode project with the web
UI built in and Capacitor included (`capacitor-swift-pm/`), so it builds with Xcode only and
no internet. Presets are `config/presets/<preset>.json`; `default` is built with no config.
Before publishing, CI builds each bundle with an empty package cache, runs `AppUITests` on it
and builds it for devices (`ui/ios-offline/verify.sh`). A published image is never replaced.
Run the workflow by hand to bundle an existing tag or a new preset.

On the corporate Mac:

1. Extract the bundle (`docker create`, `docker cp`; `docker run -t … > file` corrupts it).
2. `all-off`: run `./set-server-url.sh https://<api-host>` once. `default`: users enter the
   server in the app.
3. Open `App/App.xcodeproj` in Xcode; try it in the Simulator, then set the signing team and
   archive.
4. Distribute via MDM (Intune, Jamf) or TestFlight.

For another feature set, add `config/presets/<name>.json`, add `<name>` to the `preset`
choices and the preset list in `ios-offline.yml`, and run the workflow for it; or build from
source (see "Building Locally").
````

- [ ] **Step 3: Edit `.claude/skills/check-versions.md` iOS row**: the "Published" cell becomes `` `ios/<ver>` git tag + `ghcr.io/rophy/opencode-rc/ios:<ver>-<preset>` images (`ios-offline.yml`) ``. Leave the Android row.

- [ ] **Step 4: Check for leftovers and private names**

Run: `git grep -n "releases/ios" -- . ':!docs/superpowers/'` → no output.
Run: `git diff origin/main` and search it for the private host names and addresses the maintainer keeps out of public content, for `.local/`, `LOCAL.md` and `Claude` → none.

- [ ] **Step 5: Run all unit tests**

Run: `make unit-test`, then `cd ui && npx -y node@22 node_modules/vitest/vitest.mjs run`.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add ui/ios/README.md docs/ios-app.md .claude/skills/check-versions.md
git commit -m "docs: iOS offline bundle images replace releases/ios"
```

---

## After the plan (needs the user, not part of execution)

1. Push the branch / merge to `main` — only when the user says so. A push to `main` touching
   `ui/**` runs `ios.yml`; `ios/1.4-5` exists, so it publishes nothing.
2. Run `ios-offline.yml` by hand (`ref` empty → `ios/1.4-5`). New GHCR packages may start
   private: the user sets `ios` public in the package settings if needed.
3. Check one image on the Mac: extract, `verify.sh` passes.
4. With the user's approval, delete the remote `releases/ios` branch.
