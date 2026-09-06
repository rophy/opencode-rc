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

### 1. Gateway (`gateway/`)

A Go web service that:
- Authenticates users via corporate OIDC
- Maintains a registry of active remote control sessions (which user, which dev machine endpoint)
- Reverse proxies HTTP API requests and SSE event streams to the correct `opencode serve` instance
- Serves a dashboard listing the user's active sessions
- Serves the OpenCode web UI for individual session interaction

### 2. CLI (`cli/`)

A Node command-line tool that developers run on their dev machines:
- Performs OIDC device flow authentication against the corporate IdP
- Starts `opencode serve` by spawning it as a child process (`opencode serve --hostname 0.0.0.0 --cors <gateway-origin>`)
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

- `opencode` CLI — the CLI spawns `opencode serve` as a child process rather than depending on `@opencode-ai/sdk`
- OpenCode web app static assets — served by the gateway from `WEBUI_DIR`

## Assumptions

- Dev machines and gateway are on the same corporate network (gateway can reach dev machines directly)
- Corporate OIDC provider is available for both device flow (CLI) and authorization code flow (web)
- OpenCode is installed on dev machines

## Implementation

### Gateway (Go)

Environment variables:
| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Listen port (default: 8080) |
| `OIDC_ISSUER` | Yes | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Yes | OAuth client ID |
| `OIDC_CLIENT_SECRET` | No | OAuth client secret (for confidential clients) |
| `OIDC_REDIRECT_URI` | Yes | OAuth callback URL (e.g. `https://gateway.corp/auth/callback`) |
| `COOKIE_SECRET` | Yes | 32-byte hex string for session cookie encryption |
| `COOKIE_DOMAIN` | No | Cookie domain scope |
| `WEBUI_DIR` | No | Path to OpenCode web app `dist/` directory |

### CLI (Node)

Environment variables:
| Variable | Required | Description |
|----------|----------|-------------|
| `OPENCODE_RC_GATEWAY_URL` | Yes | Gateway URL (e.g. `https://gateway.corp`) |
| `OIDC_ISSUER` | Yes | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Yes | OAuth client ID (must support device flow) |
| `OIDC_TOKEN_ENDPOINT` | No | Override token endpoint (default: `{issuer}/oauth/token`) |
| `OIDC_DEVICE_ENDPOINT` | No | Override device auth endpoint (default: `{issuer}/oauth/device/code`) |

The CLI does not depend on `@opencode-ai/sdk`; it starts the local server via `child_process.spawn("opencode", ["serve", "--hostname", "0.0.0.0", "--port", "4096", "--cors", gatewayOrigin])` and parses the "listening on" line from its stdout to discover the bound URL.

### URL Routing

| Path Pattern | Handler | Auth |
|---|---|---|
| `/healthz` | Health check | None |
| `/auth/login` | OIDC login redirect | None |
| `/auth/callback` | OIDC callback | None |
| `/gateway/register` | CLI registration | Bearer token |
| `/gateway/heartbeat` | CLI heartbeat | Bearer token |
| `/gateway/deregister` | CLI deregister | Bearer token |
| `/gateway/sessions` | List user's sessions (JSON) | Cookie |
| `/` | Dashboard HTML | Cookie |
| `/s/{sessionID}/api/*` | Reverse proxy to dev machine | Cookie |
| `/s/{sessionID}/*` | OpenCode web UI static files | Cookie |
