# iOS App Distribution

## Overview

Package the rc-web UI as a native iOS app using Capacitor for corporate distribution.

## Architecture

Capacitor wraps the rc-web SPA in a WKWebView. The app loads the gateway URL
(e.g. `https://gateway.internal/`) — it does not bundle API endpoints. OIDC auth
works unchanged because the WebView follows the same cookie-based redirect flow
as a regular browser.

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
# Build web
cd opencode-rc/web
OPENCODE_ROOT=../opencode bun run build

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
