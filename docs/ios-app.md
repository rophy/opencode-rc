# iOS App Distribution

## Overview

Package the UI (`ui/`) as a native iOS app using Capacitor for corporate distribution.

## Architecture

Capacitor wraps the UI in a WKWebView and serves it from the app bundle. The app
talks to the API host (e.g. `https://api.internal/`), which serves only JSON.

Login runs in the system browser (see "Sign-In and Navigation"); the app then
holds an access token (15 min) and a refresh token (stored in `localStorage`,
valid 7 days).

## Sign-In and Navigation

The app signs in through the system browser (`ASWebAuthenticationSession` on iOS,
Custom Tabs on Android), not in its WebView: it opens
`<api>/auth/start?return_to=com.opencode.rc:/auth/done`, the IdP may use any hosts,
and the API finally redirects to `com.opencode.rc:/auth/done#code=…`, which the
system hands back to the app. The app exchanges the code together with its
verifier for tokens, so a callback stolen from this app's own login attempt is
useless.

Residual risk: a malicious app on the device can start its own login with its own
verifier and register to receive the callback (iOS lets any app supply a matching
`callbackURLScheme`; on Android another app can register the same custom scheme),
the general weakness of private-use callback schemes (RFC 8252 section 8.6). To keep
such a login from completing silently, the API asks the IdP to prompt the user on app
logins (OIDC `prompt`, chart `auth.appLoginPrompt`, default `select_account`); check
that your IdP honors it. Claimed https redirects (Associated Domains / App Links)
would verify the app, but need a paid Apple team and, for intranet-only hosts, MDM
managed mode; they are not planned.

The WebView loads only the bundled app (`allowNavigation: []`); every other link
opens in Safari (Android: the default browser). API calls (`fetch`, WebSockets)
are not navigations and are not affected.

## Build-Time config.json

To preset the server, write `config.json` into `ui/dist/` after `bun run build` and
before `npx cap sync`:

```json
{ "serverUrl": "https://rc.corp.example.com" }
```

Users then never see the server settings screen.

## Distribution

On every push to `main`, `.github/workflows/ios.yml` builds the UI, runs
`npx cap sync ios`, and force-pushes the resulting Xcode project (with the web
assets already bundled) to the `releases/ios` branch. It tags each new
`MARKETING_VERSION`-`CURRENT_PROJECT_VERSION` as `ios/<version>`.

On the corporate Mac:

1. Clone the `releases/ios` branch, or `git fetch && git reset --hard origin/releases/ios`
   an existing clone (the branch is force-pushed).
2. Optionally preset the server: put `{"serverUrl": "https://rc.corp.example.com"}`
   into `App/App/public/config.json`.
3. Open `App/App.xcodeproj` in Xcode, set the corporate signing team, build.
4. Distribute via MDM (Intune, Jamf) or TestFlight.

No Node, bun, or opencode source is needed on that Mac, only Xcode.

## Building Locally

```bash
cd ui
bun run build
cp /path/to/config.json dist/config.json   # optional: preset the server
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
