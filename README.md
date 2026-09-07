# OpenCode RC

Remote control gateway for [OpenCode](https://github.com/anomalyco/opencode).

OpenCode RC sits between developers and their OpenCode instances, adding OIDC authentication, multi-user session management, and a web UI for selecting and connecting to sessions.

## How It Works

```
Developer's machine                    Gateway                         Browser
┌─────────────────┐    register     ┌──────────────┐    OIDC login   ┌──────────────┐
│ opencode serve   │───────────────>│  opencode-rc  │<──────────────>│  rc-web SPA   │
│ (via rc-cli)     │<───────────────│  gateway      │───────────────>│  session list  │
│                  │  proxy /api/*  │              │  proxy to       │  opencode UI   │
└─────────────────┘                └──────────────┘  dev machine    └──────────────┘
```

1. **rc-cli** starts `opencode serve` on a developer's machine and registers it with the gateway
2. **Gateway** authenticates users via OIDC and maintains a registry of active sessions
3. **rc-web** provides a session picker and wraps the OpenCode web UI with user info and logout
4. Browser traffic is proxied through the gateway to the correct developer machine

## Components

| Component | Language | Description |
|-----------|----------|-------------|
| `gateway/` | Go | Reverse proxy with OIDC auth, session registry, WebSocket support |
| `cli/` | Node | Starts opencode serve, authenticates with gateway, heartbeat registration |
| `web/` | TypeScript/SolidJS | SPA wrapping OpenCode's web UI with session picker and user bar |

## Quick Start

```bash
# Clone
git clone --recurse-submodules <repo-url>
cd opencode-rc

# Build web UI
cd vendor/opencode && bun install && cd ..
cd web && bun install && bun run build && cd ..
```

## Running Locally with Docker Compose

The `e2e/` directory provides a Docker Compose setup with all components:

- **gateway** — the OpenCode RC gateway
- **oidc-mock** — a mock OIDC provider with test users (alice/bob)
- **dev-machine** — a simulated OpenCode instance backed by an AI mock
- **rc-client** — auto-registers the dev-machine with the gateway

### Start the environment

```bash
cd e2e
docker compose up -d --build
```

This starts the gateway, OIDC mock, and a simulated dev machine. By default the gateway is only accessible from within the Docker network.

### Expose the gateway to localhost

To access the gateway from your browser, add the `expose` profile with a port:

```bash
cd e2e
GATEWAY_PORT=8080 docker compose --profile expose up -d --build
```

Then open http://localhost:8080 in your browser. You'll be redirected to the mock OIDC login.

### Register a dev machine session

To have a session appear in the session picker, also start the `rc` profile:

```bash
cd e2e
GATEWAY_PORT=8080 docker compose --profile expose --profile rc up -d --build
```

### Serve the rc-web UI

To serve the custom web UI instead of the built-in dashboard, set `WEBUI_HOST_DIR` to the absolute path of `web/dist/`:

```bash
cd e2e
WEBUI_HOST_DIR=$(cd ../web/dist && pwd) GATEWAY_PORT=8080 \
  docker compose --profile expose --profile rc up -d --build
```

### Test users

The OIDC mock provides two test users:

| Username | Email |
|----------|-------|
| user1 | alice@example.com |
| user2 | bob@example.com |

No password is required — select a user at the mock login page.

## Configuration

The gateway is configured via environment variables:

| Variable | Description |
|----------|-------------|
| `PORT` | Listen port (default: 8080) |
| `OIDC_ISSUER` | OIDC provider URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | OIDC client secret |
| `OIDC_REDIRECT_URI` | OAuth callback URL |
| `COOKIE_SECRET` | 64-char hex string for session cookies |
| `COOKIE_SECURE` | Set to `true` for HTTPS |
| `WEBUI_DIR` | Path to rc-web dist directory (optional — falls back to built-in dashboard) |

## Requirements

- Go 1.22+
- Node.js / Bun
- Docker (for e2e environment)

## License

See [OpenCode](https://github.com/anomalyco/opencode) for upstream license terms.
