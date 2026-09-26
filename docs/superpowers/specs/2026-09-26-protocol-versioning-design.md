# Protocol Versioning Between Clients and Servers

Date: 2026-09-26
Status: Approved design
Replaces: the proposal in `docs/api-versioning.md` (which this change rewrites)

## Problem

Clients drift behind the servers. The mobile app lags because of MDM and app-store
rollouts, and users update the npm CLI late. After a breaking server change, old
clients fail in confusing ways: the pre-0.6 app cannot sign in and shows raw JSON,
and older CLIs lose the terminal without saying why. A newer client talking to an
older server fails just as confusingly.

## Goals

- A client too old for its server is blocked with a clear message: "update the app",
  "reload the page" or "update the CLI".
- A server too old for its client is detected too, and the client says so: "ask your
  administrator to upgrade".
- Compatibility is expressed as small integers per boundary, independent of release
  versions.

## Non-goals

- Soft warnings or "recommended version" banners.
- Negotiating features or keeping several protocol versions alive at once.
- Versioning opencode's own API traffic through `/proxy/*`.

## Decisions

| Topic | Decision |
|---|---|
| Behavior | Hard block with a message, in both directions |
| Key | One integer protocol version per boundary: UI ↔ API, and CLI ↔ gateway |
| Transport | Header `OpenCode-RC-Protocol: <n>` on requests and responses |
| Enforcement | Only at the entry points every session goes through (approach C) |
| Starting values | Every protocol and every minimum is `1`. A missing header counts as `0`, so every client released before this change is blocked. |

## Versioning rule

- **Server side:** make a change that old clients cannot handle, bump the server's
  protocol, and raise the server's minimum client protocol once those clients are no
  longer supported.
- **Client side:** when a client relies on new server behavior, raise the client's
  minimum server protocol.
- Release versions (package.json, `gateway/VERSION`, `Chart.yaml`) are independent of
  protocol numbers.

## Components

### Constants

| Component | File | Speaks | Requires the other side ≥ |
|---|---|---|---|
| API | `api/src/protocol.ts` | `PROTOCOL = 1` | `MIN_CLIENT_PROTOCOL = 1` |
| Gateway | `gateway/protocol.go` | `TunnelProtocol = 1` | `MinCLIProtocol = 1` |
| UI | `ui/src/protocol.ts` | `PROTOCOL = 1` | `MIN_SERVER_PROTOCOL = 1` |
| CLI | `cli/src/protocol.ts` | `PROTOCOL = 1` | `MIN_GATEWAY_PROTOCOL = 1` |

The header name is `OpenCode-RC-Protocol`. The value is a non-negative decimal integer.
A missing header, or one that isn't a valid integer, reads as `0`.

### API

- Every response carries `OpenCode-RC-Protocol: <PROTOCOL>`. `/healthz` also returns
  `"protocol": <PROTOCOL>` in its JSON body.
- CORS adds the header to `Access-Control-Expose-Headers`, so browser code can read it.
  The request header is already allowed, because the CORS middleware reflects
  `Access-Control-Request-Headers`.
- The client check applies to `/api/*`, `POST /auth/token` and `POST /auth/refresh`.
  If the client protocol is below `MIN_CLIENT_PROTOCOL`, the response is
  `426 Upgrade Required` with
  `{"error":"client_outdated","client":<n>,"minimum":<MIN>,"server":<PROTOCOL>}`.
- Not checked: `/auth/start`, `/auth/callback` (browser navigations cannot set
  headers), `/auth/logout` (logout must always work), `/proxy/*`, `/healthz`.

### Gateway

- Every response carries `OpenCode-RC-Protocol: <TunnelProtocol>`.
- `/tunnel` checks the client protocol before authentication:
  - No header: `403`, `text/plain`:
    `opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest`.
    CLIs released before this change print the pre-flight body on 401, 403 and 5xx,
    so they show this message.
  - Header below `MinCLIProtocol`: `426` with the same JSON shape as the API.
- `/healthz` also returns `"protocol"`.

### UI (web and mobile apps)

- Every API request made through `authFetch` and the auth module's `postJson` sends the
  header. opencode's `/proxy` traffic is untouched.
- The same wrappers inspect responses:
  - A `426` with `error: "client_outdated"` puts the app in the **client outdated** state.
  - A response from the API without the header, or with a value below
    `MIN_SERVER_PROTOCOL`, puts the app in the **server outdated** state.
- Either state replaces the whole UI with a screen:
  - Client outdated, native app: "This version of OpenCode RC is no longer supported by
    your server. Please update the app."
  - Client outdated, web: "A new version of OpenCode RC is available." with a Reload button.
  - Server outdated: "Your OpenCode RC server is older than this app supports. Ask your
    administrator to upgrade it."
- The server settings screen reads `protocol` from `/healthz`. It refuses to save a server
  below `MIN_SERVER_PROTOCOL`, and a server without the field counts as `0`.

### CLI

- The CLI sends the header on the `/tunnel` pre-flight and on the WebSocket upgrade.
- The pre-flight response decides the next step:
  - `426` with `client_outdated`: print
    "opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest"
    and exit non-zero.
  - Response header missing or below `MIN_GATEWAY_PROTOCOL`: print
    "The gateway at <url> is older than this CLI supports. Ask your administrator to
    upgrade it." and exit non-zero.
  - Neither error is retried by the reconnect loop.

## Error handling

| Situation | Result |
|---|---|
| Pre-0.6 app | 426 on `/api/me` or `/auth/token`. The old app has no screen for it; it shows as a failed sign-in |
| Current app, old API (no header) | Server-outdated screen |
| Web UI stale after a server upgrade | Reload screen |
| CLI released before this change | 403 pre-flight; it prints the update message |
| Current CLI, old gateway | "Gateway older than this CLI" message, exit |
| Garbage header value | Treated as 0 |

## Testing

- API unit tests:
  - the check on each enforced path;
  - the unchecked paths still work without the header;
  - the response header is on every response, including 404 and 426;
  - CORS exposes the header;
  - `/healthz` returns `protocol`.
- Gateway unit tests:
  - `/tunnel` returns 403 without the header and 426 when the value is too low;
  - the check runs before authentication;
  - the response header is present.
- UI unit tests:
  - the header is sent;
  - both states are triggered correctly and render their screens;
  - the settings screen rejects an old server.
- CLI unit tests:
  - the header is sent on the pre-flight and the WebSocket;
  - both errors are fatal and are not retried.
- e2e:
  - the vitest helpers that call the API send the header;
  - `/api/me` without the header returns 426;
  - a tunnel pre-flight without the header returns 403 with the message;
  - Playwright passes unchanged, because the real UI sends the header.

## Documentation

`docs/api-versioning.md` is rewritten to describe this mechanism and the versioning rule.
