# OpenCode RC — iOS

This branch contains a pre-built Xcode project for the OpenCode RC iOS app.
It is auto-generated from the `main` branch by CI — do not edit directly.

## Prerequisites

- macOS with Xcode 16+
- Apple Developer account (for code signing)

## Quick Start

```bash
git clone --branch releases/ios --single-branch --depth 1 \
  https://github.com/rophy/opencode-rc.git opencode-rc-ios
```

## Build & Sign

1. Open `App/App.xcodeproj` in Xcode
2. Select your team under **Signing & Capabilities**
3. Set the bundle identifier (default: `com.opencode.rc`)
4. **Product → Archive**
5. **Distribute App** — choose your distribution method

## Updating

Pull the latest build:

```bash
git pull origin releases/ios
```

Or re-clone with `--depth 1` for a clean copy.
