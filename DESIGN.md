# OpenCode RC Design

Remote control for OpenCode with OIDC authentication, designed for corporate air-gapped environments.

## Problem

Developers need to run OpenCode agents on their machines while accessing them from a browser through a centralized server with corporate OIDC authentication. Dev machines may not be reachable from the server — they sit behind NAT, firewalls, or VPN.

## Architecture

```
┌─────────────┐       ┌───────────────────────────────────┐
│  Browser     │       │  Kubernetes                       │
│  (Web UI)    │──────▶│  ┌─────────────┐  ┌────────────┐ │
│              │ HTTPS │  │ Web Server  │  │  Gateway   │ │
│              │◀──────│  │ (Bun/Hono)  │──│  (Go)      │ │
└─────────────┘       │  └──────┬──────┘  └─────┬──────┘ │
                      │         │               │         │
                      │    ┌────┴────┐          │         │
                      │    │  Redis  │          │         │
                      │    └─────────┘     WebSocket      │
                      └───────────────────────────────────┘
                                                │ (outbound)
                      ┌─────────────────────────┘
                      │
               ┌──────┴──────┐       ┌──────────────┐
               │  Dev Machine │       │  Dev Machine  │
               │  opencode-rc │       │  opencode-rc  │
               │  (CLI)       │       │  (CLI)        │
               └──────────────┘       └───────────────┘
```

The key design decision is the **reverse WebSocket tunnel**: dev machines connect outward to the gateway, so they don't need inbound network access. This works behind NAT, firewalls, and corporate VPN without port forwarding.

## Components

### API Server (`api/` — TypeScript, Hono + Bun)

- Authenticates browser users via OIDC (authorization code flow with confidential client)
- Manages session cookies (HMAC-SHA256 signed)
- Looks up active sessions in Redis
- Proxies browser requests through the gateway's tunnel to dev machines
- Serves the SPA (session picker + OpenCode web UI)

### Gateway (`gateway/` — Go)

- Accepts WebSocket tunnel connections from CLI clients
- Registers sessions in Redis (key: `orc:session:{id}`, set: `orc:user-sessions:{userId}`)
- Multiplexes browser HTTP requests through the tunnel to the correct dev machine
- Stateless — multiple replicas share Redis for session lookup

### CLI (`cli/` — Node)

- Authenticates via OIDC authorization code flow with PKCE (public client, opens browser)
- Starts `opencode serve` as a child process
- Opens a WebSocket tunnel to the gateway (outbound connection)
- Forwards requests arriving through the tunnel to the local `opencode serve`

### Web UI (`ui/` — SolidJS)

- Session picker: lists the user's active sessions
- User bar: shows logged-in user, logout, home navigation
- Wraps the upstream OpenCode web interface for individual sessions

## User Flow

1. Developer runs `opencode-rc` on their machine
2. CLI authenticates via OIDC (opens browser), starts `opencode serve`, connects tunnel to gateway
3. Gateway registers the session in Redis
4. User opens the web UI in a browser, authenticates via OIDC
5. API server shows the session picker with the user's active sessions
6. User clicks a session — API server proxies all requests through gateway tunnel to the dev machine
7. User interacts with the OpenCode agent through the standard web UI

## URL Routing

| Path | Handler | Auth |
|------|---------|------|
| `/healthz` | Health check | None |
| `/auth/login` | OIDC login page | None |
| `/auth/callback` | OIDC callback | None |
| `/auth/logout` | Logout | None |
| `/api/me` | Current user info | Cookie |
| `/gateway/sessions` | List user's sessions | Cookie |
| `/s/{sessionId}/*` | Proxy to dev machine via tunnel | Cookie |
| `/assets/*` | SPA static assets | Cookie |
| `/` | Session picker (SPA) | Cookie |

## Key Design Decisions

- **Reverse tunnel over direct proxy**: Dev machines connect outward, eliminating the need for inbound network access. This is essential for corporate environments with strict firewall rules.
- **Two images, not one**: API server (Bun) and gateway (Go) are separate containers. The API server handles auth and static serving; the gateway handles tunnel multiplexing. They scale independently.
- **Redis as session store**: Shared state between API server and gateway. Gateway writes sessions; API server reads them. Enables horizontal scaling of both components.
- **HMAC-SHA256 cookies**: Simple, stateless cookie signing. Incompatible with the previous Go gorilla/securecookie format — upgrading requires a one-time re-login.
- **Two OIDC clients**: API uses a confidential client (server-side secret). CLI uses a public client with PKCE (no secret on dev machines).
