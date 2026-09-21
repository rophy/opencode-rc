# API Versioning (TODO)

## Problem

External clients (mobile app, CLI) can drift behind server versions. We need a way to detect and reject incompatible clients.

## Client-Server Boundaries

Web + Gateway are co-deployed via the Helm chart, so their internal compatibility is guaranteed. External clients can drift:

| Server | Client | Risk |
|--------|--------|------|
| Web API | UI (web/mobile) | Mobile app versions lag behind server (app store review delays) |
| Gateway | CLI | Users may not update CLI promptly |

UI always connects to Web API. CLI always connects to Gateway. UI never talks to Gateway directly.

## Proposed Design

Each server advertises an integer `apiVersion`, bumped only on breaking API changes (independent of the release version). The two `apiVersion` values (Web API and Gateway) are independent.

- Client sends its understood `apiVersion` (e.g. via header or handshake)
- Server rejects clients below its minimum with a descriptive error ("please update to >= X")
- Server accepts clients with equal or higher `apiVersion` (newer client, older server is fine)

## Open Questions

- Where to expose `apiVersion` — `/healthz` response? Dedicated endpoint?
- Header name for client version (e.g. `X-Api-Version`)
- How to surface upgrade prompts in mobile app vs CLI
