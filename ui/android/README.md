# OpenCode RC — Android

This branch contains a pre-built Android project for the OpenCode RC Android app, with the
web app and Capacitor's Android library included. It is auto-generated from the `main`
branch by CI — do not edit directly.

The build is generic: users enter the server. To preset the server or disable features,
build from source with a config.json (`OPENCODE_RC_CONFIG`, see `config/schema.ts` on
`main`).

## Prerequisites

- JDK 21
- Android SDK (`ANDROID_HOME`), or Android Studio

## Quick Start

```bash
git clone --branch releases/android --single-branch --depth 1 \
  https://github.com/rophy/opencode-rc.git opencode-rc-android
cd opencode-rc-android
./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

For a release build, add your signing config to `app/build.gradle` and run
`./gradlew assembleRelease` (or `bundleRelease` for Google Play).

CI publishes this branch only for a new `versionName`-`versionCode`, tags it
`android/<version>`, and uploads the debug APK as a workflow artifact.

## Updating

The branch is force-pushed; update with
`git fetch && git reset --hard origin/releases/android`, or re-clone with `--depth 1`.
