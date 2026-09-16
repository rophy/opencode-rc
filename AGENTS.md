# OpenCode RC

Remote control for OpenCode in corporate environments with OIDC auth.

See `LOCAL.md` for environment-specific info.
This file is gitignored — if it doesn't exist, there is no local-specific configuration.

## Project Structure

```
web/            # TypeScript (Hono + Bun) — web server: OIDC auth, dashboard, SPA serving, proxy to gateway
gateway/        # Go — tunnel gateway (WebSocket tunnel, mux, Redis session registration)
cli/            # Node CLI — OIDC login, starts opencode serve, tunnels to gateway
ui/             # rc-web SPA — wraps @opencode-ai/app with session picker + user bar
e2e/            # Kind + Skaffold e2e test environment
charts/         # Helm chart for Kubernetes deployment
vendor/opencode # Git submodule — upstream opencode source (build dependency for ui/)
docs/           # Design docs
```

## Git Submodule

`vendor/opencode` is a git submodule tracking upstream opencode, pinned to a release tag.

```bash
# Clone with submodule
git clone --recurse-submodules <repo-url>

# If already cloned without submodules
git submodule update --init --recursive

# Bump opencode version
cd vendor/opencode && git fetch --tags && git checkout <new-tag>
cd ../.. && git add vendor/opencode && git commit -m "chore: bump opencode to <new-tag>"
```

## Building

### UI (rc-web SPA)

rc-web uses a custom Vite resolve plugin to compile against opencode source in the submodule.

```bash
# Install deps in submodule (one-time after clone)
cd vendor/opencode && bun install

# Build rc-web
cd ui && bun install && bun run build
```

Output: `ui/dist/` — static SPA served by the web server via `WEBUI_DIR`.

Override opencode location: `OPENCODE_ROOT=../path/to/opencode bun run build`

### Web Server

```bash
cd web && bun install && bun run src/index.ts
```

### Gateway

```bash
cd gateway && go build -o opencode-rc .
./opencode-rc
```

### Dev server (UI)

```bash
cd ui && bun run dev
```

Proxies `/api`, `/auth`, `/gateway`, `/s`, `/healthz` to `localhost:12029`.

## E2E Tests

E2e tests run on a kind (Kubernetes in Docker) cluster using Skaffold to build images and deploy the actual Helm chart. This ensures the chart is tested end-to-end.

```bash
# Run all tests (vitest + playwright) with Go coverage
./e2e/run.sh

# Run only vitest
./e2e/run.sh --vitest

# Run only playwright
./e2e/run.sh --playwright

# Keep cluster after tests (for debugging)
./e2e/run.sh --no-teardown

# Skip coverage collection
./e2e/run.sh --no-coverage
```

Coverage report is written to `.cover/coverage.html` and `.cover/coverage.out`.

The test environment deploys:
- The Helm chart (web, gateway, redis, oidc-mock) with `local` profile
- An aimock service (mock AI backend)
- A dev-machine pod (Playwright image with CLI + test runner)

Tests run inside the dev-machine pod via `kubectl exec`.

## npm Publishing (CLI)

The CLI (`cli/`) is published to npm as `opencode-rc` using **npm trusted publishing** (OIDC).

- CI uses `npm stage publish` (not `npm publish`) — this creates a pending version that a maintainer approves on npmjs.com
- `npm stage publish` is a newer npm feature: it stages a version for review instead of publishing immediately
- The trusted publisher is configured on npmjs.com to only allow staged publishes from GitHub Actions
- Workflow: `.github/workflows/cli.yml` — test job on PR+main, publish job on main only
- The publish job checks if the version already exists on npm before staging

## Kubectl

This project uses `kind-opencode-rc-e2e` kubectl context for e2e tests and `kind-kind` for local development.
