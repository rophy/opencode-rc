# OpenCode RC

Remote control for OpenCode in corporate environments with OIDC auth.

See `LOCAL.md` for environment-specific info.
This file is gitignored — if it doesn't exist, there is no local-specific configuration.

## Project Structure

```
gateway/        # Go reverse proxy with OIDC auth and session registry
cli/            # Node CLI — OIDC login, starts opencode serve, registers with gateway
web/            # rc-web SPA — wraps @opencode-ai/app with session picker + user bar
e2e/            # Docker Compose test environment
vendor/opencode # Git submodule — upstream opencode source (build dependency for web/)
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

### Web (rc-web)

rc-web uses a custom Vite resolve plugin to compile against opencode source in the submodule.

```bash
# Install deps in submodule (one-time after clone)
cd vendor/opencode && bun install

# Build rc-web
cd web && bun install && bun run build
```

Output: `web/dist/` — static SPA served by the gateway via `WEBUI_DIR`.

Override opencode location: `OPENCODE_ROOT=../path/to/opencode bun run build`

### Gateway

```bash
cd gateway && go build -o gateway .
```

### Dev server (web)

```bash
cd web && bun run dev
```

Proxies `/api`, `/auth`, `/gateway`, `/s`, `/healthz` to `localhost:12029`.

## Docker Compose

```bash
# Full stack with gateway exposed on localhost:8080
docker compose --profile expose --profile rc up -d --build

# With rc-web UI
WEBUI_HOST_DIR=$(cd web/dist && pwd) \
  docker compose --profile expose --profile rc up -d --build

# Run e2e tests (requires stack to be running)
./e2e/test/test.sh
```

Default ports: gateway 9080, oidc-mock 9081, dev-machine 9082.
Override with `GATEWAY_PORT`, `OIDC_MOCK_PORT`, `DEV_MACHINE_PORT`.

## npm Publishing (CLI)

The CLI (`cli/`) is published to npm as `opencode-rc` using **npm trusted publishing** (OIDC).

- CI uses `npm stage publish` (not `npm publish`) — this creates a pending version that a maintainer approves on npmjs.com
- `npm stage publish` is a newer npm feature: it stages a version for review instead of publishing immediately
- The trusted publisher is configured on npmjs.com to only allow staged publishes from GitHub Actions
- Workflow: `.github/workflows/cli.yml` — test job on PR+main, publish job on main only
- The publish job checks if the version already exists on npm before staging

## Kubectl

This project uses `kind-kind` kubectl context for local development.
