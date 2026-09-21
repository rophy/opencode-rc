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

## Versioning

All components share a single version number and must stay in sync.

**Version locations:**

| Component | File | Field |
|-----------|------|-------|
| Web | `web/package.json` | `version` |
| UI | `ui/package.json` | `version` |
| CLI | `cli/package.json` | `version` |
| Gateway | `gateway/VERSION` | entire file |
| Helm chart | `charts/opencode-rc/Chart.yaml` | `version` + `appVersion` |

The gateway binary reads its version at build time from `gateway/VERSION` via ldflags (`-X main.version=$(cat VERSION)`).

**Bumping versions:**

```bash
# Example: bump to 0.4.0
VERSION=0.4.0

# Node packages
cd web && npm version $VERSION --no-git-tag-version && cd ..
cd ui && npm version $VERSION --no-git-tag-version && cd ..
cd cli && npm version $VERSION --no-git-tag-version && cd ..

# Gateway
echo -n "$VERSION" > gateway/VERSION

# Helm chart
sed -i "s/^version: .*/version: $VERSION/" charts/opencode-rc/Chart.yaml
sed -i "s/^appVersion: .*/appVersion: \"$VERSION\"/" charts/opencode-rc/Chart.yaml

git add web/package.json ui/package.json cli/package.json gateway/VERSION charts/opencode-rc/Chart.yaml
git commit -m "chore: bump version to $VERSION"
```

Follow [semver](https://semver.org/): patch for bug fixes, minor for new features, major for breaking changes.

## npm Publishing (CLI)

The CLI is published to npm as `opencode-rc` using npm trusted publishing (OIDC).

- CI uses `npm stage publish` — stages a version for review on npmjs.com
- Workflow: `.github/workflows/cli.yml`
- The publish job checks if the version already exists before staging
