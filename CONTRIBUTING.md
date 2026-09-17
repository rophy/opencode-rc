# Contributing

## Project Structure

```
web/            # TypeScript (Hono + Bun) — web server: OIDC auth, dashboard, SPA serving, proxy to gateway
gateway/        # Go — tunnel gateway (WebSocket tunnel, mux, Redis session registration)
cli/            # Node CLI — OIDC login, starts opencode serve, tunnels to gateway
ui/             # SolidJS SPA — session picker + OpenCode web UI wrapper
e2e/            # Kind + Skaffold e2e test environment
charts/         # Helm chart for Kubernetes deployment
vendor/opencode # Git submodule — upstream OpenCode source (build dependency for ui/)
```

## Prerequisites

- Go 1.22+
- Node.js 22+ / Bun
- Docker
- [kind](https://kind.sigs.k8s.io/) (Kubernetes in Docker)
- [Skaffold](https://skaffold.dev/)
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

### Gateway

```bash
cd gateway && go build -o opencode-rc .
```

### Web UI

```bash
cd vendor/opencode && bun install
cd ../../ui && bun install && bun run build
```

Output: `ui/dist/` — static SPA served by the web server via `WEBUI_DIR`.

### UI Dev Server

```bash
cd ui && bun run dev
```

Proxies `/api`, `/auth`, `/gateway`, `/s`, `/healthz` to `localhost:12029`.

## Running Tests

### E2E Tests (Kind + Skaffold)

E2e tests run on a kind cluster using Skaffold to build images and deploy the actual Helm chart. This ensures the chart is tested end-to-end.

```bash
# Run all tests (vitest + playwright)
./e2e/run.sh

# Run only vitest
./e2e/run.sh --vitest

# Run only playwright
./e2e/run.sh --playwright

# Keep cluster after tests (for debugging)
./e2e/run.sh --no-teardown
```

The test environment deploys:
- The Helm chart (web, gateway, redis, oidc-mock) with `local` profile
- An aimock service (mock AI backend)
- A dev-machine pod (Playwright image with CLI + test runner)

Tests run inside the dev-machine pod via `kubectl exec`.

### Web Server Unit Tests

```bash
cd web && bun run test
```

### CLI Unit Tests

```bash
cd cli && npx vitest run
```

### Helm Chart Tests

```bash
helm unittest charts/opencode-rc
```

## Git Submodule

`vendor/opencode` tracks upstream OpenCode, pinned to a release tag.

```bash
# Bump opencode version
cd vendor/opencode && git fetch --tags && git checkout <new-tag>
cd ../.. && git add vendor/opencode && git commit -m "chore: bump opencode to <new-tag>"
```

## Gateway Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_ISSUER` | Yes | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Yes | CLI OAuth client ID (public, PKCE) |
| `OIDC_REDIRECT_URI` | Yes | OAuth callback URL |
| `COOKIE_SECRET` | Yes | 64-char hex string (32 bytes) for session cookie encryption |
| `COOKIE_DOMAIN` | No | Cookie domain scope |
| `COOKIE_SECURE` | No | Set to `false` for HTTP (default: `true`) |
| `REDIS_URL` | Yes | Redis connection URL |
| `POD_IP` | Yes | Pod IP for session registration |
| `TLS_INSECURE_SKIP_VERIFY` | No | Set to `true` to skip TLS certificate verification |

## npm Publishing (CLI)

The CLI is published to npm as `opencode-rc` using npm trusted publishing (OIDC).

- CI uses `npm stage publish` — stages a version for review on npmjs.com
- Workflow: `.github/workflows/cli.yml`
- The publish job checks if the version already exists before staging
