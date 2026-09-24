# Bearer Token Auth for Web UI and Mobile App

Date: 2026-09-24
Status: Draft, pending review

## Problem

The web UI assumes it is served from the same origin as the API. Login sets an
`orc_session` HttpOnly cookie (`SameSite=Lax`), and every UI request relies on the
browser attaching it. The web server has no CORS handling.

The mobile app (Capacitor) runs the bundled UI from `https://localhost` (Android) or
`capacitor://localhost` (iOS), so every API call is cross-origin, and `orc_session`
becomes a third-party cookie that both WebViews block by default. The app works around
this with CapacitorHttp (native networking), which caused these observed bugs on
Android:

- responses carry `content-length: 0` with a non-empty chunked body; the opencode SDK
  reads them as `{}` (worked around in `ui/src/fix-response.ts`)
- `ArrayBuffer` request bodies are sent empty (worked around with `Uint8Array`)
- streaming responses are buffered, so the `/global/event` SSE stream never delivers
  events and live updates do not appear (not worked around)

In addition, the OIDC callback redirects to the server's `/`, so after login the app
leaves the bundled UI and runs the server-hosted copy.

Separately, the terminal WebSocket is broken today for all clients: `/s/:id/*` is
proxied by web with `fetch()`, which cannot carry a WebSocket upgrade (observed: `502`
on `/s/<id>/pty/<pty>/connect`).

## Goals

- One auth model for browser and app: the UI never assumes the API is on its origin.
- Bearer tokens (short-lived access + rotating refresh) instead of cookies.
- The app uses the WebView's normal `fetch`; CapacitorHttp is disabled.
- After login, the app returns to its bundled UI.
- The login code is bound to the client that started the login (PKCE-style verifier),
  so a stolen or injected code cannot be exchanged by anyone else.
- The terminal WebSocket works through web.

## Non-goals

- iOS navigation policy (IdP allowed only during login, other links open in Safari,
  iframes blocked). Separate follow-up.
- Keychain/Keystore storage. The storage interface allows adding it later.
- CLI / tunnel auth. Unchanged (CLI sends its OIDC `id_token` to the gateway).
- Login via system browser. Login stays inside the WebView.

## Decisions

| Topic | Decision |
|---|---|
| Token issuer | opencode-rc web issues its own tokens (not IdP tokens passed through) |
| Token model | Access token (15 min, stateless HMAC) + refresh token (opaque, Redis, rotating) |
| Session length | 7 days absolute from login, no sliding extension |
| Client storage | Access token in memory; refresh token in `localStorage` for both browser and app |
| App login | Inside the WebView; callback redirects back to the app's local URL |
| Login code binding | PKCE-style: the UI sends `code_challenge = base64url(sha256(verifier))` to `/auth/start` and the verifier to `/auth/token` |
| WebSocket auth | `?access_token=` query parameter, accepted only on upgrade requests |

## Server design

### Tokens

- **Access token**: same format as today's cookie, `base64url(json) + "." + base64url(hmac_sha256)`,
  payload `{typ: "access", uid, email, name, exp}`. Signed with `TOKEN_SECRET`.
  Verifiers must check the MAC, `typ == "access"`, and `exp`.
- **Refresh token**: 32 random bytes, base64url. Redis stores only `sha256(token)`:
  - `rt:<hash>` → `{chain, uid, email, name, rotatedTo?, rotatedAt?}`,
    TTL = remaining chain lifetime
  - `chain:<id>` → `{uid, exp}`, TTL = 7 days from login (absolute)
- **Login code**: `code:<random>` → `{claims: {uid, email, name}, challenge}`, TTL 60 s,
  deleted on first use (`GETDEL`), including when the verifier is wrong.

### Rotation and reuse

`POST /auth/refresh {refresh_token}`:

1. Look up `rt:<hash>`. Missing, or `chain:<id>` missing → `401 invalid_grant`.
2. Not yet rotated → issue a new refresh token in the same chain, mark the old one
   `rotatedTo=<new hash>, rotatedAt=now`, return a new access + refresh pair.
3. Already rotated, within 30 s of `rotatedAt` → return the same pair it was rotated
   to (tolerates concurrent refresh from two tabs).
4. Already rotated, more than 30 s ago → treat as theft: delete `chain:<id>`,
   `401 invalid_grant`.

Refresh tokens never extend the chain's absolute expiry.

### web endpoints

| Endpoint | Behaviour |
|---|---|
| `GET /auth/start?return_to=<url>&code_challenge=<challenge>` | `return_to` is either a path starting with a single `/` (same origin as the server; default `/`), or an absolute URL whose origin is allowed (below); control characters and backslashes are rejected anywhere, and paths are normalized with the URL parser and must stay on the server's origin; otherwise `400`. The browser UI served by the server sends a path; the app sends its absolute local URL. `code_challenge` is required: 43-char base64url (`base64url(sha256(verifier))`), else `400 {"error":"invalid_request"}`. Stores state, `return_to` and the challenge in short-lived HttpOnly cookies (`orc_state`, `orc_return`, `orc_challenge`; same-site only during the redirect), redirects to the IdP. |
| `GET /auth/callback` | Validates state, exchanges the code with the IdP, verifies the ID token (unchanged). Creates a login code bound to the challenge and redirects to `<return_to>#code=<code>`. Does not set `orc_session`. |
| `POST /auth/token {code, code_verifier}` | Consumes the code, checks `base64url(sha256(code_verifier))` against the stored challenge (constant-time), creates a chain, returns `{access_token, refresh_token, expires_in}`. Unknown/expired/used code, or a missing/wrong verifier → `400 invalid_grant` (the code is burned either way). |
| `POST /auth/refresh {refresh_token}` | See rotation above. Returns `{access_token, refresh_token, expires_in}`. |
| `POST /auth/logout {refresh_token}` | Deletes the chain. Always `204`. |
| `GET /api/me`, `GET /gateway/sessions` | Bearer required. |

**Allowed origins** (for `return_to` and CORS): the server's own origin,
`capacitor://localhost`, `https://localhost`, plus `auth.allowedOrigins` from Helm.

**CORS**: for allowed origins, respond with `Access-Control-Allow-Origin: <origin>`,
`Vary: Origin`, allow methods `GET, POST, PUT, PATCH, DELETE, OPTIONS` and headers
`Authorization, Content-Type` plus any requested `x-opencode-*` headers. No
`Access-Control-Allow-Credentials`. Preflight `OPTIONS` answered without auth.

**Auth middleware**: reads `Authorization: Bearer <token>`. On WebSocket upgrade
requests only, also accepts `?access_token=`. Failure → `401 {"error":"unauthorized"}`.

### Path layout

`/s/:id/*` currently mixes SPA pages, static files and the API proxy. Split them:

| Path | Purpose | Auth |
|---|---|---|
| `/`, `/assets/*`, any other non-API path (including `/s/:id/...`) | SPA: serve the file if it exists, else `index.html` | none |
| `/proxy/:id/*` | Forward to the gateway: HTTP, SSE, WebSocket | Bearer (WebSocket: `?access_token=`) |
| `/api/*`, `/auth/*`, `/gateway/*`, `/healthz` | As above | As above |

Unknown paths under `/api/`, `/auth/`, `/gateway/` and `/proxy/` return
`404 {"error":"not found"}`, never the SPA.

`/s/:id/...` URLs stay valid as SPA routes (bookmarks keep working); the server no
longer looks up the session to serve `index.html`.

`/proxy/:id/*` handler:

- Looks up session metadata; missing or owned by another user → `404`.
- HTTP: forwards to `http://<gatewayAddr>/proxy/<id>/<rest>` with `fetch()`, passing the
  `Authorization` header and setting `X-Opencode-Directory` (as today).
- WebSocket: accepts the upgrade (`server.upgrade` in Bun), opens a WebSocket to the
  gateway's `/proxy/<id>/<rest>` with `Authorization: Bearer <token>`, strips
  `access_token` from the forwarded query, and relays messages (text and binary) and
  close codes in both directions.

### gateway

`GatewayProxyHandler` (`/proxy/`) replaces the `orc_session` cookie check with:
`Authorization: Bearer` (and `?access_token=` on upgrade requests), verified with the
same HMAC code plus `typ == "access"` and `exp`. The ownership check is unchanged.
The cookie is no longer accepted.

## UI design

### `ui/src/auth.ts` (new)

Owns all token handling:

- `getAccessToken()`: returns the in-memory token if it has more than 30 s left;
  otherwise refreshes. Refresh is single-flight within a tab, and across tabs uses
  `navigator.locks.request("orc-refresh")`; after taking the lock it re-reads the
  refresh token from `localStorage` in case another tab rotated it.
- `authFetch(url, init)`: adds `Authorization: Bearer`. On `401` forces one refresh
  and retries once. If the refresh fails with `invalid_grant`, clears tokens and
  signals the app to show the login screen.
- `login()` (async): generates a random 32-byte verifier (base64url), stores it in
  `sessionStorage` (falling back to `localStorage`) under `opencode-rc-login-verifier`,
  computes `code_challenge = base64url(sha256(verifier))` (`crypto.subtle`, with a
  JS fallback for plain-http origins where it is unavailable) and navigates to
  `${server}/auth/start?return_to=<current page>&code_challenge=<challenge>`, where the
  current page is a path (`pathname + search`) when the UI is served by the server
  itself, and the absolute URL without fragment otherwise (the app).
- `completeLogin()`: at startup, if the fragment has `code=`, removes it with
  `history.replaceState`, then reads and removes the stored verifier. Without a
  verifier (a login this client did not start) it returns "expired" without calling
  the server; otherwise it calls `POST /auth/token {code, code_verifier}`.
- `logout()`: `POST /auth/logout`, clears tokens.

Refresh token storage key: `opencode-rc-refresh`. Storage goes through a small
interface so a Keychain/Keystore implementation can replace it later.

### Changes to existing UI code

- `api.ts`: `fetchMe` and `fetchSessions` use `authFetch`.
- `login-screen.tsx`, `user-bar.tsx`: call `login()` / `logout()`.
- `entry.tsx` fetch wrapper: rewrites opencode API calls to `${server}/proxy/<id>/...`
  and adds the bearer header. The `/s/` prefix rewriting and origin special-casing go
  away.
- `entry.tsx` WebSocket wrapper: wraps `window.WebSocket`; for URLs under
  `${server}/proxy/`, appends `access_token=<fresh token>`.
- Remove the CapacitorHttp workarounds (`fix-response.ts`, the `Uint8Array` body change).

### Capacitor

- `capacitor.config.ts`: `CapacitorHttp.enabled: false`.
- Login stays in the WebView; `allowNavigation` stays as is for now (navigation policy
  is a separate follow-up).

## Configuration

| Helm value | Env | Default | Purpose |
|---|---|---|---|
| `secrets.tokenSecret` | `TOKEN_SECRET` | falls back to `secrets.cookieSecret` / `COOKIE_SECRET` | HMAC key, shared by web and gateway |
| `auth.accessTokenTTL` | `ACCESS_TOKEN_TTL` | `15m` | Access token lifetime |
| `auth.sessionTTL` | `SESSION_TTL` | `7d` | Absolute refresh-chain lifetime |
| `auth.allowedOrigins` | `ALLOWED_ORIGINS` | `[]` | Extra origins for `return_to` and CORS |

`COOKIE_DOMAIN` is removed. `COOKIE_SECURE` remains on web only, for the short-lived login cookies (`orc_state`, `orc_return`, `orc_challenge`).

## Error handling

| Situation | Response | UI behaviour |
|---|---|---|
| Missing/invalid/expired/wrong-`typ` access token | `401 {"error":"unauthorized"}` (web and gateway) | Refresh once, retry |
| Refresh token unknown, reused past grace, or chain expired | `401 {"error":"invalid_grant"}` | Clear tokens, show login |
| Login code unknown/expired/used, or verifier missing/wrong | `400 {"error":"invalid_grant"}` | Show login with "Sign-in expired, try again" |
| `return_to` not allowed | `400` from `/auth/start` | None (no redirect happens) |
| Redis unavailable | `503` from `/auth/token`, `/auth/refresh` | Error shown; existing access tokens keep working until they expire |

## Risks to verify early

1. **iOS redirect to `capacitor://localhost/#code=…`**: not verified that WKWebView
   follows an `https` → `capacitor://` 302. Fallback: the callback returns a minimal
   HTML page that calls `location.replace(...)`.
2. **Server URLs loaded without fetch** in the opencode UI (e.g. `<img src>`, downloads,
   `window.open`) will not carry the token. Search the opencode app for these during
   implementation and handle each.

## Testing

- **web unit**: token sign/verify (MAC, `typ`, `exp`); code exchange (single use,
  TTL, verifier check); refresh rotation, grace window, chain revocation on reuse; `return_to`
  allowlist; CORS preflight; `/proxy/:id` ownership check; WebSocket relay.
- **gateway unit**: bearer and `?access_token=` on upgrade accepted; cookie rejected;
  wrong `typ` and expired tokens rejected.
- **UI unit**: `auth.ts` (single-flight refresh, retry on 401, clear on
  `invalid_grant`, `completeLogin` fragment removal); fetch and WebSocket wrappers.
- **e2e vitest**: replace the cookie-jar login with code → token → bearer; add refresh,
  logout revocation, and a terminal WebSocket round trip through `/proxy/:id`.
- **e2e Playwright**: browser golden path; reload keeps the user logged in via refresh.
- **Manual**: Android emulator (login in WebView, session view, prompt, live update);
  iOS on a Mac, including risk 1.

## Rollout

- One release bumping web, gateway and chart together.
- Existing logins end once (cookies are ignored).
- CLI and tunnel unchanged.
