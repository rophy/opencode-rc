# Mobile Shell Without Capacitor

Date: 2026-11-03
Status: Draft

## Problem

The iOS and Android apps are Capacitor projects, but they use almost nothing from Capacitor:
a WebView that loads the bundled UI, a navigation handler, and a bridge for one local plugin
(`SystemAuth`). No native features (camera, files, push) are used. Capacitor still costs:

- The iOS project depends on `capacitor-swift-pm` (two binary frameworks). The offline bundle
  has to vendor them (`ui/ios-offline/bundle.sh`), and corporate build systems see a third-party
  dependency they must review.
- The Android project includes `capacitor-android` from `node_modules` and a generated
  `capacitor-cordova-android-plugins` module; the release job copies them in.
- Builds need `npx cap sync`, and `capacitor.config.json` is one more file that
  `set-server-url.sh` edits.
- The iOS origin `capacitor://localhost` names a framework the app would no longer use.

Separately, the app must never load a non-allowlisted web page inside the app, because the app's
traffic may go over a corporate per-app VPN. Today the main WebView sends external links to the
system browser (Capacitor's default), but the iOS sign-in sheet (`SystemAuthPlugin.swift`) loads
any http(s) page, including links on the IdP's pages, and WKWebView link previews are on.

## Goals

- iOS: a plain UIKit app with one WKWebView, no third-party dependencies.
- Android: a plain Activity with one WebView; only AndroidX libraries.
- Same user-facing behavior as today, with these changes:
  - iOS origin `opencode-rc://localhost` (was `capacitor://localhost`).
  - Navigation lock: the app loads only the bundled UI and, in the iOS sign-in sheet, only
    allowlisted hosts. Everything else opens in the system browser.
- The JS UI has no `@capacitor/*` packages.
- The offline iOS bundle is the plain Xcode project with the built UI; nothing vendored.

## Non-goals

- Native networking for API traffic (HTTP, SSE, WebSocket through URLSession or OkHttp). A
  possible later project, decided by the per-app VPN device test. The shell must not block it.
- Changing the sign-in flow (e.g. a Safari view that loads only the IdP, with a public client
  and PKCE). Also a possible later project.
- Restricting subresources (scripts, images, fonts) on IdP pages in the sign-in sheet.
- Compatibility with the old origin or with Capacitor builds: there are no installed users.
- A version bump.

## Design

### JS side (`ui/src/`)

`native.ts` replaces `@capacitor/core`:

```ts
export function isNativeApp(): boolean
export function signIn(opts: { url: string; callbackScheme: string; allowedHosts: string[] }): Promise<{ url: string }>
```

- `isNativeApp()` is true when the shell has injected `window.rcNative`.
- `signIn` rejects with an error whose `code` is `cancelled` or `failed`, as the plugin does
  today, so the error handling in `auth.ts` stays the same.
- `auth.ts`, `protocol-screen.tsx` and `system-auth.ts` use it; `system-auth.ts` is removed if
  nothing else is left in it.
- `ui/package.json` drops `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios` and
  `@capacitor/android`.

Before calling `signIn`, `auth.ts` reads `GET /auth/cli-config` and builds `allowedHosts`:
the server's host, the authorization endpoint's host, and the build-time `signInHosts`.
Hosts are compared as `host[:port]`, lower case.

### Bridge protocol

Same on both platforms.

- At document start, the shell injects a script that defines `window.rcNative` with
  `call(method, args): Promise<unknown>`.
- JS → native: `{ id, method, args }`. Native → JS: `{ id, result }` or
  `{ id, error: { code, message } }`. Each id gets exactly one reply.
- Methods: `signIn` only.
- Native code accepts a message only from the main frame of the app origin; other messages are
  dropped and logged.
- One sign-in at a time: a new `signIn` rejects the pending one with `cancelled`.

iOS uses a `WKScriptMessageHandlerWithReply`, which checks `message.frameInfo`.
Android uses `WebViewCompat.addWebMessageListener`, limited to the app origin, not
`addJavascriptInterface`, which every frame can reach.

### App origin

| Platform | Origin | How |
|---|---|---|
| iOS | `opencode-rc://localhost` | `WKURLSchemeHandler` for scheme `opencode-rc` |
| Android | `https://localhost` | `androidx.webkit.WebViewAssetLoader` with domain `localhost` |

`APP_ORIGINS` in `api/src/origins.ts` becomes `["opencode-rc://localhost", "https://localhost"]`.
The sign-in callback stays `com.opencode.rc:/auth/done`.

The iOS scheme handler serves `App/public/`:

- A path with no file extension that matches no file → `index.html` (SPA routes).
- A missing file with an extension → 404.
- A path that resolves outside `public/` → 404.
- MIME type from a fixed table by extension (html, js, mjs, css, json, map, svg, png, jpg, ico,
  webp, woff, woff2, ttf, wasm, txt); others `application/octet-stream`.

### Navigation rules: main WebView (both platforms)

| Load | Result |
|---|---|
| App origin | Allow |
| External http(s): link, `location`, form submit, `target=_blank`, `window.open` | Open in the system browser; cancel in the app |
| Other schemes (`tel:`, `mailto:`, app links) | Hand to the OS; cancel in the app |
| Subframe to anything but the app origin | Cancel |

iOS sets `allowsLinkPreview = false`. The CSP (`ui/csp.ts`) does not change.

### Navigation rules: iOS sign-in sheet

Applies to main-frame navigations and to `target=_blank` / `window.open`:

| Target | Result |
|---|---|
| Host in `allowedHosts` (http(s)) | Load in the sheet |
| The callback scheme | Finish sign-in with the URL |
| Any other http(s) URL | Open in Safari; the sheet stays on its page |
| Any other scheme | Cancel |

Subframes inside the sheet follow the same host check. Subresources are not restricted.

Android signs in through a Custom Tab, which is the browser, not the app, so no allowlist applies.

### API

`GET /auth/cli-config` always returns `authorizationEndpoint`: the override if set, otherwise
the discovered `authorization_endpoint`. The CLI already prefers this field, so its behavior
does not change.

### Config

`config/schema.ts` gets an optional `signInHosts: string[]` (host or `host:port`, no scheme,
no path). The UI build uses it; the API ignores it. README "Deployment Config" documents it.

### iOS project (`ui/ios/App/`)

- `AppDelegate.swift`, `SceneDelegate.swift`.
- `WebViewController.swift`: creates the WKWebView, the scheme handler, the bridge, the
  navigation delegate, the safe-area layout (as `SafeAreaViewController` today).
- `AppSchemeHandler.swift`, `NavigationPolicy.swift` (pure decision functions for both tables,
  unit-tested), `Bridge.swift`, `SignInSheet.swift` (today's `SignInSheetController` plus the
  allowlist).
- No `CapApp-SPM`, no `capacitor.config.json`, no `config.xml`, no
  `capacitor-cordova-ios-plugins`.
- A new `AppTests` unit-test target, next to `AppUITests`.

### Android project (`ui/android/`)

- `MainActivity.java`: the WebView, `WebViewAssetLoader`, `WebViewClient` with the main-WebView
  rules, the bridge listener, the callback intent filter for `com.opencode.rc`.
- `NavigationPolicy.java` (pure, unit-tested), `SignIn.java` (Custom Tab + callback;
  `cancelled` when the app resumes without a callback, `failed` when no browser can open it).
- Gradle drops `capacitor-android`, `capacitor-cordova-android-plugins`,
  `capacitor.settings.gradle`, `capacitor.build.gradle`; adds `androidx.webkit`.

### Build and CI

- `ui/build/sync-mobile.ts` with `bun run sync:ios` and `bun run sync:android`: replaces the
  target folder (`ios/App/App/public`, `android/app/src/main/assets/public`) with `dist`.
- `.github/workflows/ios.yml`, `ios-offline.yml`, `android.yml`: `npx cap sync` →
  `bun run sync:*`. `android.yml` no longer copies `capacitor-android`. Android CI also runs
  `./gradlew test`. iOS CI runs the `AppTests` target with `AppUITests`.
- `ui/ios-offline/bundle.sh`: no vendoring; checks that the project has no package
  dependencies. `verify.sh`: no `capacitor-swift-pm` check. `set-server-url.sh`: no
  `capacitor.config.json` edit (only the pbxproj and the web files).

### Error handling

- Sign-in sheet load error → `failed` with the error text. Swipe down → `cancelled`.
- A callback with no `code` → `failed` (JS checks this today).
- Bridge: unknown method → `{ code: "failed", message: "unknown method" }`.
- Scheme handler errors → HTTP status, never a crash.

## Testing

- **vitest (ui):** `native.ts` (ids, one reply per call, errors, no bridge → not native);
  `auth-native.test.ts` moved to the new bridge; `allowedHosts` from `cli-config` and
  `signInHosts`; `sync-mobile.ts`.
- **vitest (api):** `cli-config` always has `authorizationEndpoint`; `APP_ORIGINS`.
- **config:** `signInHosts` validation.
- **iOS `AppTests`:** scheme handler (files, MIME, SPA fallback, 404, traversal); both navigation
  tables.
- **iOS `AppUITests`:** the existing launch test, on the new origin.
- **Android JUnit:** navigation rules; the bridge's origin check.
- **ios-offline:** `set-server-url.test.ts` and `verify.sh` updated.
- **Manual before release:** sign in against a test deployment on the iOS Simulator and the
  Android emulator; an external link in the app opens the browser; an external link in the
  sign-in sheet opens Safari and the sheet stays.

## Docs

`AGENTS.md` (Building: sign-in paragraph, sync step), `docs/ios-app.md`, `ui/ios/README.md`,
`ui/android/README.md`, README "Deployment Config" (`signInHosts`).
