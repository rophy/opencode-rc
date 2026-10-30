# iOS App Distribution

## Overview

Package the UI (`ui/`) as a native iOS app using Capacitor for corporate distribution.

## Architecture

Capacitor wraps the UI in a WKWebView and serves it from the app bundle. The app
talks to the API host (e.g. `https://api.internal/`), which serves only JSON.

Login runs outside the app's WebView (see "Sign-In and Navigation"); the app then
holds an access token (15 min) and a refresh token (stored in `localStorage`,
valid 7 days).

## Sign-In and Navigation

The app does not sign in in the WebView that shows the app. It opens
`<api>/auth/start?return_to=com.opencode.rc:/auth/done`, the IdP may use any hosts,
and the API finally redirects to `com.opencode.rc:/auth/done#code=…`. The app
exchanges the code together with its verifier for tokens, so a callback stolen
from this app's own login attempt is useless.

- **iOS:** a sheet with the app's own WKWebView. Its traffic belongs to the app, so a
  per-app VPN carries it (a Safari-based sheet, `ASWebAuthenticationSession`, would
  go through Safari, which such a VPN often excludes). The sheet stops the
  navigation to `com.opencode.rc:` and closes; swiping it down cancels; a page that
  cannot load closes it with a sign-in error. The IdP session is kept in the app's
  own web data, not shared with Safari, and IdPs that refuse embedded WebViews
  (e.g. Google) cannot be used.
- **Android:** a Custom Tab (the default browser), which hands the callback to the app.

Residual risk: a malicious app on the device can start its own login with its own
verifier and register to receive the callback (any iOS app can catch a matching
scheme in its own sign-in session; on Android another app can register the same custom scheme),
the general weakness of private-use callback schemes (RFC 8252 section 8.6). To keep
such a login from completing silently, the API asks the IdP to prompt the user on app
logins (OIDC `prompt`, chart `auth.appLoginPrompt`, default `select_account`); check
that your IdP honors it. Claimed https redirects (Associated Domains / App Links)
would verify the app, but need a paid Apple team and, for intranet-only hosts, MDM
managed mode; they are not planned.

The WebView loads only the bundled app (`allowNavigation: []`); every other link
opens in Safari (Android: the default browser). API calls (`fetch`, WebSockets)
are not navigations and are not affected.

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
(a launch check for presets with a server) and builds it for devices
(`ui/ios-offline/verify.sh`). A published image is never replaced.
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

## Building Locally

```bash
cd ui
OPENCODE_RC_CONFIG=/path/to/config.json bun run build   # optional: preset server, features
npx cap sync ios
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
