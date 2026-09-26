# Protocol Versioning

Clients and servers exchange a small integer protocol version so that a client too old
for its server, or a server too old for its client, fails with a clear message.

## Boundaries

| Boundary | Server constant | Client constant |
|---|---|---|
| UI (web and apps) ↔ API | `api/src/protocol.ts`: `PROTOCOL`, `MIN_CLIENT_PROTOCOL` | `ui/src/protocol.ts`: `PROTOCOL`, `MIN_SERVER_PROTOCOL` |
| CLI ↔ gateway | `gateway/protocol.go`: `TunnelProtocol`, `MinCLIProtocol` | `cli/src/protocol.ts`: `PROTOCOL`, `MIN_GATEWAY_PROTOCOL` |

The API and gateway are deployed together by the chart, so they need no versioning
between them.

## Mechanism

- Requests and responses carry `OpenCode-RC-Protocol: <n>`. A missing or invalid value
  counts as 0. `/healthz` also reports `"protocol"`.
- The API checks the client on `/api/*`, `/gateway/*`, `POST /auth/token` and
  `POST /auth/refresh` and answers `426 {"error":"client_outdated", ...}` when it is too
  old. `/auth/start`, `/auth/callback`, `/auth/logout`, `/proxy/*` and `/healthz` are not
  checked.
- The gateway checks `/tunnel` before authentication: `426` JSON for a versioned but
  outdated CLI, and a plain-text `403` for CLIs that send no header (older CLIs print
  that body).
- The UI shows a full-screen message: update the app, reload the page, or ask the
  administrator to upgrade the server. The CLI prints the matching message and exits.
- Clients treat a missing or too-low server header as "server outdated" only for
  non-5xx responses; 5xx responses (often from a proxy or ingress while the server or
  gateway restarts) are ordinary errors and get retried, not flagged as outdated.
- CLIs released before protocol versioning existed keep retrying and print the update
  message (a plain-text 403 from the gateway) on each attempt, since they have no
  protocol check of their own to stop them.

## When to change the numbers

- A server change that old clients cannot handle: bump the server's protocol. Raise its
  minimum client protocol when those clients are no longer supported.
- A client that relies on new server behaviour: raise the client's minimum server
  protocol.
- Release versions are independent of protocol numbers.
