# Contributing

## Project Structure

```
backend/        # Go — single binary with two subcommands: gateway, tunneler
cli/            # Node CLI — OIDC login, starts opencode serve, tunnels to gateway
web/            # SolidJS SPA — session picker + OpenCode web UI wrapper
e2e/            # Docker Compose test environment + Vitest/Playwright tests
charts/         # Helm chart for Kubernetes deployment
vendor/opencode # Git submodule — upstream OpenCode source (build dependency for web/)
```

## Prerequisites

- Go 1.22+
- Node.js 22+ / Bun
- Docker and Docker Compose
- Helm 3 (for chart testing)
- [helm-unittest](https://github.com/helm-unittest/helm-unittest) plugin

## Setup

```bash
git clone --recurse-submodules <repo-url>
cd opencode-rc

# If already cloned without submodules
git submodule update --init --recursive
```

## Building

### Backend

```bash
cd backend && go build -o opencode-rc .
```

### Web UI

```bash
cd vendor/opencode && bun install
cd ../../web && bun install && bun run build
```

Output: `web/dist/` — static SPA served by the gateway via `WEBUI_DIR`.

### Web Dev Server

```bash
cd web && bun run dev
```

Proxies `/api`, `/auth`, `/gateway`, `/s`, `/healthz` to `localhost:12029`.

## Docker Compose

The compose environment runs all components on an internal Docker network with no exposed ports. Tests and manual operations run inside the `dev-machine` container.

```bash
# Full stack
docker compose --profile rc up -d --build

# With rc-web UI (build web first)
WEBUI_HOST_DIR=$(cd web/dist && pwd) \
  docker compose --profile rc up -d --build
```

## Running Tests

### Vitest E2E

```bash
docker compose exec -T dev-machine sh -c "cd /e2e && npx vitest run"
```

### Playwright Browser E2E

```bash
docker compose exec dev-machine sh -c "cd /e2e && npx playwright test"
```

### CLI Unit Tests

```bash
cd cli && npx vitest run
```

### Helm Chart Tests

```bash
helm unittest charts/opencode-rc
```

### E2E with Coverage

```bash
./e2e/coverage.sh
```

## Git Submodule

`vendor/opencode` tracks upstream OpenCode, pinned to a release tag.

```bash
# Bump opencode version
cd vendor/opencode && git fetch --tags && git checkout <new-tag>
cd ../.. && git add vendor/opencode && git commit -m "chore: bump opencode to <new-tag>"
```

## Backend Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Listen port (default: 8080) |
| `OIDC_ISSUER` | Yes | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Yes | Web OAuth client ID |
| `OIDC_CLIENT_SECRET` | No | Web OAuth client secret |
| `OIDC_CLI_CLIENT_ID` | No | CLI OAuth client ID (public, PKCE) |
| `OIDC_REDIRECT_URI` | Yes | OAuth callback URL |
| `COOKIE_SECRET` | Yes | 64-char hex string (32 bytes) for session cookie encryption |
| `COOKIE_DOMAIN` | No | Cookie domain scope |
| `COOKIE_SECURE` | No | Set to `false` for HTTP (default: `true`) |
| `WEBUI_DIR` | No | Path to `web/dist/` directory |
| `REDIS_URL` | Yes | Redis connection URL |
| `POD_IP` | Yes (tunneler) | Pod IP for tunneler registration |
| `TLS_INSECURE_SKIP_VERIFY` | No | Set to `true` to skip TLS certificate verification |

## npm Publishing (CLI)

The CLI is published to npm as `opencode-rc` using npm trusted publishing (OIDC).

- CI uses `npm stage publish` — stages a version for review on npmjs.com
- Workflow: `.github/workflows/cli.yml`
- The publish job checks if the version already exists before staging
