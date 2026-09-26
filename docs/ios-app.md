# iOS App Distribution

## Overview

Package the rc-web UI as a native iOS app using Capacitor for corporate distribution.

## Architecture

Capacitor wraps the rc-web SPA in a WKWebView. The app is configured with the
API host (e.g. `https://api.internal/`), which serves no HTML — it does not
bundle API endpoints.

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
`callbackURLScheme`; on Android another app can register the same custom scheme).
With an active IdP session, that flow would complete and hand the malicious app
tokens for the user — the verifier only protects flows the real app started (RFC
8252 section 8.6). The same exposure existed with the previous `capacitor://`
`return_to`. Mitigation would be claimed https redirects (Universal Links / App
Links), currently a non-goal.

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

## Docker Image as Transport

The gateway Docker image serves double duty — runtime and iOS project transport:

```
Docker image contents:
├── /gateway              # Go binary (deployed to k8s)
└── /ios-project/         # Capacitor project with pre-built web dist
    ├── ios/              # Xcode project
    └── dist/             # pre-built web assets (already cap-synced)
```

## Corporate Build & Distribution Workflow

1. Pull gateway Docker image into corporate environment
2. Deploy gateway to Kubernetes as usual
3. Extract iOS project: `docker cp <container>:/ios-project ./`
4. Open in Xcode, set corporate signing team
5. Build and distribute via MDM (Intune, Jamf) or TestFlight

No Node, bun, or opencode source repo needed on the corporate Mac — just Xcode.

## Requirements

- Mac with Xcode (Intel or Apple Silicon)
- Apple Developer account: free Apple ID for local testing, $99/yr program for distribution
- Corporate signing key for enterprise distribution
- Device network access to the gateway URL (VPN if internal)

## Build Pipeline (CI side)

```bash
# Build web, then add the build-time config
cd opencode-rc/ui
bun run build
cp /path/to/config.json dist/config.json

# Sync into Capacitor iOS project
npx cap sync

# Package into Docker image alongside gateway binary
cd ../gateway
docker build ...  # Dockerfile copies /gateway binary + /ios-project/
```

## TODO

- [ ] Initialize Capacitor in web/ (`npx cap init`)
- [ ] Add iOS platform (`npx cap add ios`)
- [ ] Configure Capacitor to load gateway URL instead of local files
- [ ] Update Dockerfile to include ios-project in image
- [ ] Test on a physical iOS device
- [ ] Document corporate signing and MDM distribution steps
