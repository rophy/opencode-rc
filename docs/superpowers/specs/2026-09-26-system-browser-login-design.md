# Mobile Sign-In in the System Browser

Date: 2026-09-26
Status: Approved design
Builds on: `2026-09-24-bearer-token-auth-design.md` (login codes, code verifier, `/auth/token`)

## Problem

The mobile app runs the OIDC login inside its WebView. With a WebView navigation
allowlist, any IdP page on a host outside the list opens in the system browser
mid-flow; the login then finishes there and never returns to the app. IdPs move
between hosts freely (MFA services, federation, CDNs), so no fixed list is safe.
Some IdPs also refuse embedded WebViews outright (Google's `disallowed_useragent`),
and passkeys, device-bound MFA and existing browser SSO sessions work best in the
system browser.

## Goals

- The mobile app signs in through the system's authentication browser
  (iOS `ASWebAuthenticationSession`, Android Custom Tabs), per RFC 8252.
- The WebView only ever shows the bundled app: `allowNavigation` is empty, and
  every link to another site opens in the system browser.
- The web UI's sign-in is unchanged.

## Non-goals

- RP-initiated logout at the IdP (logging out of the app does not end the IdP session).
- Claimed https redirects (Universal Links / App Links).
- Per-build callback schemes.

## Decisions

| Topic | Decision |
|---|---|
| Mechanism | Local Capacitor plugin `SystemAuth` in `ui/` (Swift + Java), no new npm dependencies |
| Callback URL | `com.opencode.rc:/auth/done`, fixed (private-use scheme, RFC 8252 section 7.1) |
| Browser session | Shared with the device browser (`prefersEphemeralWebBrowserSession = false`) |
| Verifier | Held in memory by the app during the login; the WebView never navigates away |
| WebView allowlist | `allowNavigation: []`; `config.json` for mobile carries only `serverUrl` |

## Flow (native)

1. `login()` creates a code verifier and its challenge.
2. It calls `SystemAuth.start({ url, callbackScheme: "com.opencode.rc" })` with
   `url = <api>/auth/start?return_to=com.opencode.rc%3A%2Fauth%2Fdone&code_challenge=<c>`.
3. The system browser runs `/auth/start` → IdP (any hosts) → `/auth/callback`.
4. `/auth/callback` answers `302 Location: com.opencode.rc:/auth/done#code=<login code>`.
5. The system hands the callback URL to the plugin, which resolves `{ url }`.
6. `login()` reads `code` from the fragment and posts `{ code, code_verifier }` to
   `/auth/token`, storing the tokens as today.

A callback stolen from *this* login attempt (another app claiming the scheme and
receiving the app's own callback) is useless: the login code only redeems together
with the verifier, which never leaves the app. See "Residual risks" below for the
case where the other app starts its own login instead of stealing this one.

## Components

### Plugin `SystemAuth` (`ui/`)

JS interface (`ui/src/system-auth.ts`, registered with `registerPlugin`):

```ts
interface SystemAuthPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string }>
}
```

Rejections carry `code: "cancelled"` (user closed the browser) or `"failed"`.
Only one login may be pending; a second `start` rejects the first with `cancelled`.

- **iOS** (`ui/ios/App/App/SystemAuthPlugin.swift`, registered in the app's bridge
  view controller): `ASWebAuthenticationSession(url:callbackURLScheme:completionHandler:)`,
  `presentationContextProvider` = the app window,
  `prefersEphemeralWebBrowserSession = false`. `ASWebAuthenticationSessionError.canceledLogin`
  maps to `cancelled`.
- **Android** (`ui/android/app/src/main/java/com/opencode/rc/SystemAuthPlugin.java`,
  registered in `MainActivity`): opens the URL in a Custom Tab (`androidx.browser`) and
  keeps the pending call. `MainActivity` becomes `launchMode="singleTask"` with an
  intent filter for scheme `com.opencode.rc`. `handleOnNewIntent` resolves the call
  when the intent's URI has the callback scheme. If the activity resumes while a call
  is pending and no callback arrived, the call rejects with `cancelled`.

### UI (`ui/src/auth.ts`)

- Native platform (`Capacitor.isNativePlatform()`): the flow above. Cancel keeps the
  login screen without an error; failure (plugin error, missing code, token exchange
  failure) shows the existing login error.
- Web: unchanged (full-page redirect, `#code` handled by `completeLogin()`).

### API

- `origins.ts`: `APP_CALLBACK = "com.opencode.rc:/auth/done"`.
- `validateReturnTo` accepts a `return_to` equal to `APP_CALLBACK` exactly. App origins
  (`capacitor://localhost`, `https://localhost`) are no longer accepted as `return_to`;
  they stay allowed for CORS.
- `/auth/callback` answers a `302` to `APP_CALLBACK#code=…` for that target. The
  script-navigation page remains for absolute http(s) targets (the web UI host).

### Navigation allowlist

- `capacitor.config.ts`: `allowNavigation: []`; the committed iOS `capacitor.config.json` matches.
- Remove `deriveAllowNavigation`, `navigationAllowlist()` and the config screen's host check.
- `config.json` for mobile: `{ "serverUrl": "…" }` only.

## Error handling

| Situation | Behaviour |
|---|---|
| User closes the login browser | Login screen stays, no error |
| IdP or API error page in the browser | User closes it → treated as cancel |
| Callback without `code` | Login error shown |
| `/auth/token` rejects the code (expired, wrong verifier) | Login error shown |
| `return_to` not exactly `APP_CALLBACK` and not an allowed web origin/path | `/auth/start` returns 400 |

## Residual risks

A malicious app installed on the device can start its own login (with its own code
verifier) and register to receive the callback: iOS lets any app supply a matching
`callbackURLScheme` to `ASWebAuthenticationSession`, and on Android another app can
register the same custom scheme. If the user has an active IdP session, that
malicious app's login completes and it obtains tokens for the user. The verifier
only protects flows the real app started (RFC 8252 section 8.6); it does not stop
a different app from starting its own flow. The same exposure existed with the
previous `capacitor://` `return_to`. Mitigation would be claimed https redirects
(Universal Links / App Links), which is currently a non-goal.

## Testing

- API unit tests: exact `APP_CALLBACK` accepted; look-alikes rejected
  (`com.opencode.rc:/auth/done/x`, `com.opencode.rc://auth/done`, `com.opencode.rcx:/auth/done`,
  other schemes, `capacitor://localhost/`, `https://localhost/`); `/auth/callback` 302s to it with the code.
- UI unit tests: native `login()` with a mocked plugin: success stores tokens,
  cancel is silent, missing code and token failure report an error; web path unchanged.
- e2e: the existing suite keeps passing (web flow unchanged); API tests for the new `return_to`.
- Android emulator against a deployment: login via Custom Tab returns to the app
  logged in; closing the tab cancels cleanly; an external link opens the browser.
- iOS simulator on a Mac (Xcode 16.4): the same three checks.
- Spike first: confirm Chrome Custom Tabs follows a server 302 to the custom scheme
  without a user tap before building the rest.
