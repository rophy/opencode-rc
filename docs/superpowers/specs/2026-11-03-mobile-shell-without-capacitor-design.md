# Mobile Shell Without Capacitor

Date: 2026-11-03
Status: Implemented

## Problem

1. **Per-app VPN.** Corporate iOS devices route managed apps through a per-app VPN that
   excludes Safari (Safari reaches only the hosts in the VPN's Safari Domains, e.g. the
   corporate IdP). Our app's UI, API calls, SSE, WebSockets and sign-in are all WKWebView
   traffic. WebKit is designed to send WKWebView traffic as the app's traffic, but Apple DTS
   called "WKWebView not following per-app VPN" a known issue (FB9891393, 2023, no public fix),
   and corporate IT says WKWebView will not work. Native networking (URLSession) is app
   traffic by design. A corporate reference app signs in with an SFSafariViewController that
   loads only the IdP, then talks to its backend natively.
2. **Navigation lock.** The app must never load a non-allowlisted web page inside the app,
   because in-app traffic may go over the corporate VPN. Today the main WebView sends
   external links to the system browser (Capacitor's default), but the iOS sign-in sheet
   loads any http(s) page, and WKWebView link previews are on.
3. **Capacitor adds cost and no value.** The apps use only Capacitor's WebView shell, its
   navigation handler and the bridge for one local plugin. Capacitor costs a third-party
   dependency (vendored in the iOS offline bundle as two binary frameworks), `npx cap sync`,
   `capacitor.config.json`, generated Gradle modules, and an origin named after it
   (`capacitor://localhost`).

## Goals

- iOS: a plain UIKit app, one WKWebView, no third-party dependencies. The WebView makes no
  network requests: all API traffic (HTTP, SSE, WebSocket) goes through URLSession.
- Android: a plain Activity, one WebView, only AndroidX libraries.
- Sign-in on both platforms in the system browser view (iOS SFSafariViewController, Android
  Custom Tab) that loads only the IdP: the app is a public OIDC client with PKCE, and our API
  exchanges the code.
- Navigation lock: the WebView loads only the bundled UI; everything else opens in the system
  browser.
- The JS UI has no `@capacitor/*` packages.
- The offline iOS bundle is the plain Xcode project with the built UI; nothing vendored.

## Non-goals

- Native networking on Android. Android's per-app VPN works per app (UID), and WebView
  networking runs in the app's process, so WebView traffic is app traffic. To be confirmed on
  a device; revisit if it fails.
- An in-app sign-in view on Android for VPNs that exclude the browser. Revisit if a deployment
  reports it.
- Restricting subresources on IdP pages (they load in the system browser view, not the app).
- Compatibility with the old origin, the old app sign-in flow or Capacitor builds: there are no
  installed users.
- A version bump.

## Design

### App origin

| Platform | Origin | How |
|---|---|---|
| iOS | `opencode-rc://localhost` | `WKURLSchemeHandler` for scheme `opencode-rc` |
| Android | `https://localhost` | `androidx.webkit.WebViewAssetLoader` with domain `localhost` |

`APP_ORIGINS` in `api/src/origins.ts` becomes `["opencode-rc://localhost", "https://localhost"]`.

### Bridge protocol

Same on both platforms.

- At document start, the shell injects a script that defines `window.rcNative`:
  `call(method, args): Promise<unknown>` and `on(event, handler)` for native → JS events.
- JS → native: `{ id, method, args }`. Native → JS: `{ id, result }` or
  `{ id, error: { code, message } }`; each id gets exactly one reply. Events:
  `{ event, data }`.
- Native code accepts a message only from the main frame of the app origin; others are
  dropped and logged.
- iOS: `WKScriptMessageHandlerWithReply` (checks `frameInfo`); events through
  `evaluateJavaScript`. Android: `WebViewCompat.addWebMessageListener` limited to the app
  origin (not `addJavascriptInterface`, which every frame can reach); events through the
  listener's reply proxy.

Methods:

| Method | Platforms | Purpose |
|---|---|---|
| `signIn({ url, callbackScheme })` → `{ url }` | both | Open `url` in the system browser view; resolve with the callback URL. Errors `cancelled`, `failed`. One at a time: a new call rejects the pending one with `cancelled`. |
| `setServer({ origin })` | iOS | The one origin native networking may reach. |
| `wsOpen`, `wsSend`, `wsClose` + events `ws.open`, `ws.message`, `ws.close`, `ws.error` | iOS | WebSocket through URLSession. |

### JS side (`ui/src/`)

`native.ts` replaces `@capacitor/core`: `isNativeApp()` (true when `window.rcNative`
exists), `nativeCall`, `nativeOn`. `auth.ts`, `protocol-screen.tsx` and `proxy-fetch.ts`
use it; `system-auth.ts` is removed. `ui/package.json` drops `@capacitor/core`,
`@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`.

On iOS (native networking):

- The UI's server origin is `opencode-rc://localhost/__server`. `getBaseUrl()` keeps the
  real server for display and settings; `apiUrl()` and the proxy targets use the local prefix.
  All API requests, including `EventSource`, are same-origin.
- At startup and whenever the server changes, JS calls `setServer` with the real origin.
- `ProxiedWebSocket` (`proxy-fetch.ts`) uses `wsOpen`/`wsSend`/`wsClose` instead of the
  browser `WebSocket`. Binary frames are base64 in both directions.
- The CSP (`ui/csp.ts`) for the iOS build has `connect-src 'self'`.

On Android, networking stays as today (WebView `fetch`/`WebSocket` to the real server).

### iOS native networking

`AppSchemeHandler` serves two path spaces under `opencode-rc://localhost`:

- `/__server/<path>?<query>` → forwarded to `<server origin>/<path>?<query>` with URLSession:
  method, headers (minus `Origin`, `Host`, `Cookie`) and body passed through. Response status
  and headers are passed back with `didReceive(_ response:)`, the body chunk by chunk with
  `didReceive(_ data:)` as it arrives, so SSE streams. `webView(_:stop:)` cancels the task
  (`AbortController`). No server set, or a redirect to another origin → 502 with no body.
  Cookies: none (an ephemeral session; the API uses bearer tokens).
- Anything else → the bundle in `App/public/`: a path with no extension that matches no file →
  `index.html`; a missing file with an extension → 404; a path that resolves outside `public/`
  → 404; MIME type from a fixed table by extension (html, js, mjs, css, json, map, svg, png,
  jpg, ico, webp, woff, woff2, ttf, wasm, txt), otherwise `application/octet-stream`.

WebSocket: `wsOpen({ url, protocols })` → `URLSessionWebSocketTask`. The URL's origin must be
the server origin (`wss`/`ws` form); otherwise `ws.error` + `ws.close`. Messages, close codes
and errors become events.

TLS: the system trust store (the MDM installs corporate CAs). No custom trust code.

**Spike first:** confirm on iOS 17+ that `WKURLSchemeTask.request` carries the body of a
`fetch` POST (JSON prompts; file uploads up to the API's limit). If it does not, request bodies
go through the bridge (`httpBody` method keyed by a request id header) and the rest stays.

### Sign-in (both platforms)

The app is a public OIDC client with PKCE; the API exchanges the code (RFC 8252 flow, the
reference app's pattern).

1. `GET /auth/app-config` → `{ authorizationEndpoint, clientId, redirectUri, prompt? }`.
   `clientId` = `OIDC_APP_CLIENT_ID` (new); `redirectUri` = `com.opencode.rc:/auth/callback`;
   `prompt` = `APP_LOGIN_PROMPT` if set. 404 when `OIDC_APP_CLIENT_ID` is not set (the app
   then shows that the server does not support app sign-in).
2. The app creates the PKCE verifier (S256), `state` and `nonce`, builds the authorization URL
   (`response_type=code`, `scope=openid email profile`) and calls `signIn`:
   - iOS: `SFSafariViewController`. The callback arrives through
     `scene(_:openURLContexts:)` (Info.plist URL type `com.opencode.rc`); the shell closes the
     view and resolves. The view's Done button → `cancelled`.
   - Android: Custom Tab. The callback arrives through the intent filter; resuming without a
     callback → `cancelled`; no browser → `failed`.
3. The app checks `state`, reads `code` (an `error` parameter → `failed`), and calls
   `POST /auth/app-token` with `{ code, code_verifier, nonce }` (on iOS through native
   networking).
4. The API posts to the token endpoint (`OIDC_TOKEN_ENDPOINT` override honored) with
   `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri`, no
   secret. It verifies the ID token (signature, issuer, audience = app client id, `nonce`), takes
   the user claim as `/auth/callback` does, creates the token chain, logs
   `login: user=… email=… name=… client=app`, and returns the same body as `/auth/token`.
   Failures → `400 invalid_grant` (logged with the reason).
5. Removed: the app path of the web flow (`APP_CALLBACK` in `api/src/origins.ts` and
   `ui/src/auth.ts`, its `return_to` case, and `appLoginPrompt` in `/auth/start`). The web
   UI flow (`/auth/start`, `/auth/callback`, `/auth/token`) is unchanged.

Per deployment, IT adds a public client with PKCE required and the redirect URI
`com.opencode.rc:/auth/callback`. Only the IdP host must be reachable from the system browser
(on corporate iOS: in Safari Domains). The Helm chart gets `OIDC_APP_CLIENT_ID`; the e2e
oidc-mock gets a matching public client.

### Navigation rules (main WebView, both platforms)

| Load | Result |
|---|---|
| App origin | Allow |
| External http(s): link, `location`, form submit, `target=_blank`, `window.open` | Open in the system browser; cancel in the app |
| Other schemes (`tel:`, `mailto:`, app links) | Hand to the OS; cancel in the app |
| Subframe to anything but the app origin | Cancel |

iOS sets `allowsLinkPreview = false`. The rules are pure functions (`NavigationPolicy`),
unit-tested on both platforms.

### iOS project (`ui/ios/App/`)

- `AppDelegate.swift`, `SceneDelegate.swift` (URL callback).
- `WebViewController.swift`: WKWebView, scheme handler, bridge, navigation delegate,
  safe-area layout (as `SafeAreaViewController` today), `allowsLinkPreview = false`.
- `AppSchemeHandler.swift`, `ServerProxy.swift` (URLSession forwarding), `WebSocketBridge.swift`,
  `NavigationPolicy.swift`, `Bridge.swift`, `SignIn.swift` (SFSafariViewController).
- Removed: `SystemAuthPlugin.swift`, `CapApp-SPM`, `capacitor.config.json`, `config.xml`,
  `capacitor-cordova-ios-plugins`.
- New `AppTests` unit-test target next to `AppUITests`.

### Android project (`ui/android/`)

- `MainActivity.java`: WebView, `WebViewAssetLoader`, `WebViewClient` with the navigation rules,
  the bridge listener, the callback intent.
- `NavigationPolicy.java`, `Bridge.java`, `SignIn.java` (Custom Tab).
- Gradle drops `capacitor-android`, `capacitor-cordova-android-plugins`,
  `capacitor.settings.gradle`, `capacitor.build.gradle`; adds `androidx.webkit`.

### Build and CI

- `ui/build/sync-mobile.ts` (`bun run sync:ios`, `bun run sync:android`): replaces
  `ios/App/App/public` or `android/app/src/main/assets/public` with `dist`.
- The iOS build's CSP has `connect-src 'self'`; the Android and web builds keep today's.
- Workflows `ios.yml`, `ios-offline.yml`, `android.yml`: `npx cap sync` → `bun run sync:*`;
  `android.yml` no longer copies `capacitor-android` and also runs `./gradlew test`; iOS CI runs
  `AppTests` and `AppUITests`.
- `ui/ios-offline/bundle.sh`: no vendoring; fails if the project has package dependencies.
  `verify.sh`: no `capacitor-swift-pm` check. `set-server-url.sh`: no `capacitor.config.json`
  edit.

## Testing

- **vitest (api):** `/auth/app-config` (set, unset → 404, `prompt`); `/auth/app-token` against
  the test IdP (success, wrong verifier, wrong nonce, wrong audience, IdP error, user claim
  missing); `APP_ORIGINS`; the removed app path of `/auth/start` (`return_to` of the old
  callback → 400).
- **vitest (ui):** `native.ts` (ids, one reply per call, events, no bridge → not native);
  app sign-in (URL parameters, state mismatch, `error` callback, cancel, token exchange);
  iOS proxy origin in `apiUrl` and `proxy-fetch.ts`; `ProxiedWebSocket` on the native backend;
  CSP per build; `sync-mobile.ts`.
- **iOS `AppTests`:** bundle serving (MIME, SPA fallback, 404, traversal); proxy (path and
  query mapping, header filtering, streaming chunks, cancel, wrong origin, no server) against a
  local test server; WebSocket bridge origin check; navigation rules; bridge frame check.
- **iOS `AppUITests`:** launch on the new origin; sign-in screen and server settings.
- **Android JUnit:** navigation rules; bridge origin check; callback parsing.
- **e2e:** app sign-in endpoints against oidc-mock with the public client.
- **ios-offline:** `set-server-url.test.ts`, `verify.sh` updated.
- **Manual before release:** on the iOS Simulator and the Android emulator against a test
  deployment: sign in, session list, live updates (SSE), terminal (WebSocket), an upload; an
  external link opens the system browser.
- **Corporate device (user):** the 6-step per-app VPN test from the research report.

## Docs

`AGENTS.md` (Building: sign-in paragraph, sync step), `docs/ios-app.md`, `ui/ios/README.md`,
`ui/android/README.md`, README (Deployment Config, `OIDC_APP_CLIENT_ID` and the IdP client
setup), Helm chart values and README.
