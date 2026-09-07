# OpenCode RC

Remote control for OpenCode in corporate environments with OIDC auth.

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

## E2E Environment

```bash
cd e2e

# Basic (gateway + dev-machine + oidc-mock)
docker compose up -d

# With external access (requires .env.expose)
docker compose --env-file .env.expose --profile expose up -d

# With RC client registration
docker compose --profile rc up -d
```

## Kubectl

This project uses `kind-kind` kubectl context for local development.
