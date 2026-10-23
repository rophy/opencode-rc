# iOS Offline Bundle Image

Date: 2026-10-22
Status: Implemented

## Problem

Corporate teams build the iOS app on a Mac with Xcode, often in an air-gapped network. Today
`.github/workflows/ios.yml` force-pushes the synced Xcode project to the `releases/ios` branch.
That project cannot build without internet: `App/CapApp-SPM/Package.swift` depends on
`capacitor-swift-pm` from GitHub, whose binary targets download `Capacitor.xcframework.zip`
and `Cordova.xcframework.zip` from GitHub releases. It is also generic only: a team that
needs a preset server or disabled features must build the web UI from source, which needs
bun, the opencode submodules and their dependencies.

A hand-made bundle proved the fix: the synced project with `capacitor-swift-pm` included as a
local package (the release zips unzipped, `binaryTarget(path:)`), pointed to by a relative
path. It builds with an empty package cache, runs in the Simulator, and builds for devices.
Shipped as a small image holding a tarball, it moves through a registry mirror like any other
image.

## Goals

- CI publishes, for each iOS release, one image per preset that holds a self-contained Xcode
  project: it builds offline with Xcode only.
- Presets: `default` (generic build: users enter the server, all features on) and `all-off`
  (every 1.x and 2.x feature disabled, placeholder server).
- A team presets its server in an `all-off` bundle with the bundled `set-server-url.sh`.
- CI proves each bundle builds offline before it publishes it.
- The images replace the `releases/ios` branch.

## Non-goals

- Signing, or a prebuilt `.app`/`.ipa`.
- Reading the server from a separate file at runtime (a possible later app change).
- Android (`releases/android` stays as it is).
- A version bump.

## Design

### Images

    ghcr.io/rophy/opencode-rc/ios:<version>-<preset>      e.g. 1.4-5-all-off

`<version>` is `MARKETING_VERSION-CURRENT_PROJECT_VERSION`, as in the `ios/<version>` tag.
The image is `busybox` with `/bundle/opencode-rc-ios-<version>-<preset>.tgz` and its
`.sha256`. Its command lists `/bundle`; users extract with `docker create` + `docker cp`
(`docker run -t … > file` corrupts binary output). The package is public: bundles hold no
deployment-specific data.

### Presets

`config/presets/<preset>.json`, read by the UI build through `OPENCODE_RC_CONFIG`.
`default` has no file and builds as `ios.yml` does today. `all-off.json` sets `serverUrl` to
`https://rc-placeholder.invalid` and disables every feature in `features` and
`opencodeV2.features`. A unit test checks that `all-off.json` validates against
`config/schema.ts` and names every entry of `FEATURES` and `FEATURES_V2`, so a new feature
cannot be left on by mistake.

### Bundle script

`ui/build/ios-offline-bundle.sh <preset> <out-dir>` runs after the UI build and
`npx cap sync ios`, on macOS:

1. Copy `ui/ios` (without `.gitignore`, `README.md` and `project.xcworkspace`) to
   `opencode-rc-ios-<version>-<preset>/`.
2. Read the `capacitor-swift-pm` version from `App/CapApp-SPM/Package.swift`
   (`exact: "x.y.z"`). Fetch that tag's `Package.swift` and `LICENSE.md`, download the two
   zips, and check each with `swift package compute-checksum` against the upstream checksum.
3. Unzip both into `capacitor-swift-pm/`, write a local `Package.swift` with
   `.binaryTarget(name:path:)`, and change the dependency in `App/CapApp-SPM/Package.swift` to
   `.package(path: "../../capacitor-swift-pm")`.
4. For a preset with a placeholder server: add `set-server-url.sh` (replaces the placeholder
   in `App/App/public`, CSP included; validates an origin; refuses a second run).
5. Add `config.json` (the preset, if any), `LICENSE` and a `README.md` (set the server, run in
   the Simulator, sign and archive, the callback `com.opencode.rc:/auth/done`, matching API
   config).
6. Write `opencode-rc-ios-<version>-<preset>.tgz` and `.sha256`.

The same script runs on a developer Mac.

### Verification (from the extracted tarball, before publishing)

- Build for the Simulator with a new, empty `-clonedSourcePackagesDirPath`; fail if
  `workspace-state.json` names a package that is not `fileSystem` or an artifact that is not
  `local`.
- For `all-off`: run `set-server-url.sh https://rc.example.com`; fail if the placeholder
  remains or a second run succeeds.
- Run `AppUITests` (launch, sign-in button appears) on the bundle.
- Build for devices, unsigned (`CODE_SIGNING_ALLOWED=NO`).

### Workflows

`.github/workflows/ios-offline.yml`:

- `workflow_call` (input `ref`) and `workflow_dispatch` (inputs `ref`, default the latest
  `ios/*` tag; `preset`, default all).
- Matrix over presets on `macos-latest`: checkout with submodules, bun, Node 22, submodule
  deps, UI build with the preset, `cap sync ios`, bundle script, verification, then push the
  image with `GITHUB_TOKEN` (`packages: write`). It skips a tag that already exists, so a
  re-run does not overwrite a published bundle.

`ios.yml` keeps its version check, Simulator test and `ios/<version>` tag, drops the
`releases/ios` steps, and calls `ios-offline.yml` for a new version. (A tag pushed with
`GITHUB_TOKEN` starts no other workflow, so a tag trigger would never fire.)

### Docs

`ui/ios/README.md` and `docs/ios-app.md` ("Distribution"): pull the image, extract, set the
server, open in Xcode. `.claude/skills/check-versions.md`: iOS publishes the `ios` images and
the tag.

### Rollout

1. Merge; run `ios-offline.yml` by hand for `ios/1.4-5` to publish the first images.
2. Check one image on a Mac: extract, build offline, run in the Simulator.
3. Then, with the maintainer's approval, delete the remote `releases/ios` branch.

## Testing

- Unit: `all-off.json` against the schema and the feature lists (UI vitest).
- CI: the verification above, on every bundle, on every run.
- Manual: step 2 of the rollout.

## Changes in implementation

- The scripts are in `ui/ios-offline/`: `bundle.sh`, `verify.sh`, `set-server-url.sh`.
- Checksums use `shasum -a 256`.
- `bundle.sh` takes the synced `ui/ios` directory; the tools and presets come from the workflow's commit.
- The image is pushed from a Linux job (macOS runners have no Docker).
- `AppUITests` run for `default` bundles only. Bundles with a preset server get a Simulator launch
  check: the test taps "Server settings", which the app hides when a server is built in.
- The existence check treats manifest unknown, not found and denied as absent and fails on other
  errors. A concurrency group and a re-check before the push keep a published image from being replaced.

## Risks

- `capacitor-swift-pm` layout changes (another target, another `Package.swift` form): the
  script fails on what it does not recognise instead of guessing.
- Upstream download unavailable: the run fails; the published images are not affected.
- macOS runner minutes: two presets double the iOS build time on a new version only.
