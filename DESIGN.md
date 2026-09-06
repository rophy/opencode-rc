# opencode-rc

Minimalistic remote control for OpenCode with OIDC authentication, designed for corporate air-gapped environments.

## Problem

In air-gapped corporate environments, developers need a centrally managed way to remotely control OpenCode agents from a web browser, with corporate OIDC authentication.

## Architecture

```
┌─────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│  Browser     │──────▶│  Gateway              │──────▶│  Dev Machine A  │
│  (Web UI)    │ HTTPS │  - OIDC login         │ HTTP  │  opencode-rc    │
│              │◀──────│  - Session registry   │◀──────│  (serve + register)
└─────────────┘  SSE  │  - Reverse proxy      │  SSE  └─────────────────┘
                       └──────────────────────┘       ┌─────────────────┐
                                                      │  Dev Machine B  │
                                                      │  opencode-rc    │
                                                      └─────────────────┘
```

## Components

### 1. Gateway (`packages/gateway/`)

A web service that:
- Authenticates users via corporate OIDC
- Maintains a registry of active remote control sessions (which user, which dev machine endpoint)
- Reverse proxies HTTP API requests and SSE event streams to the correct `opencode serve` instance
- Serves a dashboard listing the user's active sessions
- Serves the OpenCode web UI (from `@opencode-ai/app`) for individual session interaction

### 2. CLI (`packages/cli/`)

A command-line tool that developers run on their dev machines:
- Performs OIDC device flow authentication against the corporate IdP
- Starts `opencode serve` (via `@opencode-ai/sdk`)
- Registers the local server with the gateway (with heartbeat to stay alive)
- Deregisters on shutdown

## User Flow

1. Developer runs `opencode-rc` on their dev machine
2. CLI performs OIDC device flow (open browser → login → get token)
3. CLI starts `opencode serve` locally
4. CLI registers with the gateway: "user X has a session at host:port"
5. CLI sends periodic heartbeats to keep the registration alive
6. Developer (or teammate) opens the gateway web app in a browser
7. Browser authenticates via OIDC
8. Dashboard shows the user's active sessions
9. User enters a session — gateway proxies all requests to the dev machine's `opencode serve`
10. User interacts with the OpenCode agent through the standard web UI

## Key Dependencies

- `@opencode-ai/sdk` — programmatic server management (`createOpencodeServer`)
- `@opencode-ai/app` — web UI (served by the gateway)
- `@opencode-ai/client` — typed HTTP client for the OpenCode API

## Assumptions

- Dev machines and gateway are on the same corporate network (gateway can reach dev machines directly)
- Corporate OIDC provider is available for both device flow (CLI) and authorization code flow (web)
- OpenCode is installed on dev machines
