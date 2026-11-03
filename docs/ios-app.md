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

The app signs in as a public OIDC client with PKCE, in the system browser view (iOS
`SFSafariViewController`, Android Custom Tab). That view loads only the IdP; the IdP redirects
to `com.opencode.rc:/auth/callback`, and the app sends the code and its verifier to the API
(`POST /auth/app-token`). The client settings come from `GET /auth/app-config`. A callback
stolen from this app's own login attempt is useless without the verifier.

Set up the IdP client and `oidc.appClientId` (API env `OIDC_APP_CLIENT_ID`) as described in the
README ("Mobile app sign-in"). Without a client id, app sign-in is off.

On corporate devices with a per-app VPN, Safari traffic is not carried by the app's VPN. The
IdP host must be reachable from Safari (in the VPN's Safari Domains). The API host need not be.

Residual risk: a malicious app on the device can start its own login with its own
verifier and register to receive the callback (on iOS and on Android another app can register
the same custom scheme; PKCE makes a code it steals from this app's login useless), the general weakness of private-use callback schemes (RFC 8252 section 8.6).
To keep such a login from completing silently, the API asks the IdP to prompt the user on app
logins (OIDC `prompt`, chart `auth.appLoginPrompt`, default `select_account`, applied through
`/auth/app-config`); check that your IdP honors it. Claimed https redirects (Associated Domains /
App Links) would verify the app, but need a paid Apple team and, for intranet-only hosts, MDM
managed mode; they are not planned.

The WebView loads only the bundled app; every other link opens in Safari (Android: the default
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
