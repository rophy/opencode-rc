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
features off; set your server once with the bundle's `set-server-url.sh`). In both,
`set-server-url.sh --bundle-id <id>` sets the bundle identifier. The bundle's `README.md` has
the steps. See `docs/ios-app.md`.
