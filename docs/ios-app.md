# iOS App Distribution

## Overview

Package the UI (`ui/`) as a plain native iOS app (a Swift shell around one WKWebView, no
third-party dependencies) for corporate distribution.

## Architecture

The WebView loads the bundled UI from `opencode-rc://localhost` (a `WKURLSchemeHandler`). The
app talks to the API host (e.g. `https://api.internal/`), which serves only JSON.

All server traffic (HTTP, SSE, WebSocket) goes through native `URLSession`: the page's requests
go to a `/__server` proxy in the scheme handler, and WebSockets are bridged to native sockets.
Because the traffic belongs to the app, a per-app VPN carries it. The build's CSP is
`connect-src 'self' data:`.

The app holds an access token (15 min) and a refresh token (stored in `localStorage`, valid
7 days).

## Sign-In and Navigation

The app signs in through the API with the web client, as the browser UI does. It opens the
API's `/auth/start` in a WKWebView sheet owned by the app. The API redirects to the IdP, receives
the code at its https callback (`/auth/callback`), and redirects to `com.opencode.rc:/auth/done`
with a one-time login code. The sheet stops that navigation and hands the URL to the app, which
exchanges the login code with its verifier (`POST /auth/token`). A login code stolen from this app's
login is useless without the verifier. The IdP needs no client for the app and never sees the
custom scheme.

The sheet's traffic belongs to the app, so a per-app VPN carries it; Safari-based views
(`SFSafariViewController`, `ASWebAuthenticationSession`) reach only the hosts in the VPN's Safari
Domains. The sheet loads web pages only; it stops at the callback and never hands a link to another
app. When a page cannot load, or the API answers with an error, the sheet closes and the app shows
the reason. Android signs in the same way in a Custom Tab, which receives the callback through an
intent filter.

Trade-off: the sheet is an embedded web view, which RFC 8252 advises against for sign-in (the app
could read what the user types, and some IdPs block embedded views). We use it because corporate
IdPs may reject custom-scheme redirect URIs and per-app VPNs do not carry Safari traffic.

To keep a login from completing silently, the API asks the IdP to prompt the user on app logins
(OIDC `prompt`, chart `auth.appLoginPrompt`, default `select_account`); check that your IdP honors
it.

The main WebView loads only the bundled app; every other link opens in Safari (Android: the default
browser), and iOS link previews are off.

## Build-Time Config

The deployment's `config.json` presets the server and switches features off. Name it when
building the UI:

```bash
cd ui
OPENCODE_RC_CONFIG=/path/to/config.json bun run build
```

```json
{
  "serverUrl": "https://rc.corp.example.com",
  "features": { "uploads": { "enabled": false } }
}
```

With `serverUrl` set, users never see the server settings screen and the app may only
connect to that origin. A disabled feature is removed from the app; the API enforces the
same file (chart value `config`).

## Distribution

Every push to `main` that touches the app builds it for the iOS Simulator (unsigned) and runs
the iOS tests, including `AppUITests`, a smoke test that launches the app and checks the bundled UI renders and responds.
Run it locally with `xcodebuild test -project App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=<device>' CODE_SIGNING_ALLOWED=NO`
in `ui/ios/App`, after a build without a preset server and `bun run sync:ios`. The project has two test
targets: `AppTests` (unit tests, run by the same command) and `AppUITests`.

When the push brings a new `MARKETING_VERSION`-`CURRENT_PROJECT_VERSION` (no `ios/<version>`
tag yet), `.github/workflows/ios.yml` tags it `ios/<version>` and calls
`.github/workflows/ios-offline.yml`, which publishes one image per preset:

    ghcr.io/rophy/opencode-rc/ios:<version>-<preset>

Each holds `/bundle/opencode-rc-ios-<version>-<preset>.tgz`: the Xcode project with the web
UI built in. It has no package dependencies, so it builds with Xcode only and no internet. Presets are `config/presets/<preset>.json`; `default` is built with no config.
Before publishing, CI builds each bundle, runs `AppUITests` on it
(a launch check for presets with a server) and builds it for devices
(`ui/ios-offline/verify.sh`). A published image is never replaced.
Run the workflow by hand to bundle an existing tag or a new preset.

On the corporate Mac:

1. Extract the bundle (`docker create`, `docker cp`; `docker run -t … > file` corrupts it).
2. `all-off`: run `./set-server-url.sh https://<api-host>` once. `default`: users enter the
   server in the app. In either bundle, `--bundle-id <id>` sets the bundle identifier
   (`com.opencode.rc` by default; the test targets get `<id>.tests` and `<id>.uitests`), e.g. `./set-server-url.sh --bundle-id com.corp.opencode`.
3. Open `App/App.xcodeproj` in Xcode; try it in the Simulator, then set the signing team and
   archive.
4. Distribute via MDM (Intune, Jamf) or TestFlight.

For another feature set, add `config/presets/<name>.json`, add `<name>` to the `preset`
choices and the preset list in `ios-offline.yml`, and run the workflow for it; or build from
source (see "Building Locally").

## Building Locally

```bash
cd ui
OPENCODE_RC_CONFIG=/path/to/config.json bun run build   # optional: preset server, features
bun run sync:ios
open ios/App/App.xcodeproj
```

## Requirements

- Mac with Xcode (Intel or Apple Silicon)
- Apple Developer account: free Apple ID for local testing, paid program for distribution
- Corporate signing key for enterprise distribution
- Device network access to the API host (VPN if internal)

## Open Items

- [ ] Test on a physical iOS device
- [ ] Document corporate signing and MDM distribution steps
