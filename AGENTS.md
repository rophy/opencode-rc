# OpenCode RC

Remote control for OpenCode in corporate environments with OIDC auth.

See `LOCAL.md` for environment-specific info.
This file is gitignored — if it doesn't exist, there is no local-specific configuration.

## Project Structure

```
api/            # TypeScript (Hono + Bun) — API server: OIDC auth, tokens, proxy to gateway (serves no UI)
gateway/        # Go — tunnel gateway (WebSocket tunnel, mux, Redis session registration)
cli/            # Node CLI — OIDC login, starts opencode serve, tunnels to gateway
ui/             # SolidJS SPA — session picker + OpenCode web UI wrapper
ui/web/         # nginx image packaging for ui/dist (Dockerfile, nginx.conf)
config/         # config.json schema shared by the UI build and the API
e2e/            # Kind + Skaffold e2e test environment
charts/         # Helm chart for Kubernetes deployment
vendor/opencode # Git submodule — upstream opencode source (build dependency for ui/)
vendor/patches  # Our patches to vendor/opencode, applied by the UI build per disabled feature
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

The Android app's language list (`ui/android/app/src/main/res/xml/locales_config.xml`, shown under
Settings > App languages) is generated from opencode's UI languages. After a bump, regenerate it
with `cd ui && bun build/locales-config.ts`; `ui/build/locales-config.test.ts` fails until you do.

### Patches (`vendor/patches/`)

Our changes to upstream opencode live in `vendor/patches/<feature>/*.patch`: plain `git diff`
output, paths relative to `vendor/opencode`. The submodule itself is never edited. The UI build
applies a feature's patches in memory (`ui/build/vendor-patches.ts`) when the deployment's
config.json disables that feature (e.g. `vendor/patches/uploads/` for `features.uploads`).
Patches apply with no fuzz; one that no longer applies fails the build.

```bash
# Change a patch: apply it, edit the files, write it back, reset the submodule
cd vendor/opencode
git apply ../patches/uploads/composer-v1.patch
# ...edit packages/app/src/components/prompt-input.tsx...
git diff -- packages/app/src/components/prompt-input.tsx packages/app/src/components/prompt-input/attachments.ts > ../patches/uploads/composer-v1.patch
git checkout -- .

# After bumping opencode: rebase each patch onto the new tag
git apply --3way ../patches/uploads/composer-v1.patch   # resolve conflicts, then write it back as above
```

`ui/build/upload-patches.test.ts` checks what the upload patches remove; it runs against the
pinned submodule (CI checks it out for the UI tests).

### Adding a feature toggle

A deployment switches features off in its config.json (`{"features": {"<name>": {"enabled": false}}}`).
Each feature has up to two parts, found by its name:

1. **Name**: add it to `FEATURES` in `config/schema.ts`. The schema then accepts it, the UI
   build and the API pick it up, and type-checking fails until step 3 has an entry.
2. **UI** (optional): `vendor/patches/<name>/*.patch` removes or changes it in opencode's UI.
   Applied by the UI build only while the feature is disabled. A patch directory that names no
   feature fails the build. Add a test like `ui/build/upload-patches.test.ts`.
3. **API**: an entry in `FEATURE_GUARDS` (`api/src/feature-guards.ts`): a middleware that rejects
   the feature's requests on `/proxy/*`, or `null` when the feature only changes the UI. The guard
   is the enforcement; a UI patch alone can be bypassed by calling the API directly. While any
   guard is active, write requests must have plain paths, so guards can match paths safely.
4. **e2e**: disable it in `e2e/rc-config.json` and `e2e/values.yaml` (`config:`) and test both
   parts, as the `uploads disabled` tests do.
5. **Docs**: describe it in the README's "Deployment Config" section.

## Package Managers

- `api/`, `ui/`, `vendor/opencode` — **bun** (`bun.lock`)
- `cli/` — **npm** (`package-lock.json`)

Do not mix them: don't run `bun install` in `cli/` or `npm install` in `api/`/`ui/`.

## Building

### UI (SolidJS SPA)

The UI uses a custom Vite resolve plugin to compile against opencode source in the submodule.

```bash
# Install deps in submodule (one-time after clone)
cd vendor/opencode && bun install

# Build the UI
cd ui && bun install && bun run build
```

Output: `ui/dist/` — consumed by the UI image (`ui/web/`), the iOS project and the Android project.

The iOS/Android apps sign in through the system browser (local `SystemAuth` plugin, callback
`com.opencode.rc:/auth/done`) and their WebView loads only the bundled app. To preset the server
or disable features, build with `OPENCODE_RC_CONFIG=/path/to/config.json bun run build`
(schema: `config/schema.ts`; see `docs/ios-app.md`).

Override opencode location: `OPENCODE_ROOT=../path/to/opencode bun run build`

### API Server

```bash
cd api && bun install && bun run src/index.ts
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

Proxies `/api`, `/auth`, `/gateway`, `/proxy`, `/healthz` to `localhost:12029`.

## E2E Tests

E2e tests run on an existing kind (Kubernetes in Docker) cluster using Skaffold to build images and deploy the actual Helm chart into a namespace. This ensures the chart is tested end-to-end. The scripts never create or delete clusters: create one once (`kind create cluster --config e2e/kind-config.yaml`, adding any machine-specific settings such as a registry mirror), then point `KUBE_CONTEXT` at it or make it the current context.

```bash
# Target cluster and namespace (defaults: current kubectl context, opencode-rc)
export KUBE_CONTEXT=kind-opencode-rc-e2e NAMESPACE=opencode-rc

# Deploy, run all tests (vitest + playwright, with gateway coverage), then delete the namespace
./e2e/run.sh

# Step by step, e.g. to keep the environment for debugging
make up         # create the namespace and deploy
make e2e-test   # run the tests (repeatable)
make down       # delete the namespace (only if make up created it)
```

Coverage report is written to `.cover/coverage.html` and `.cover/coverage.out`.

`make up` creates the namespace (labeled `app.kubernetes.io/managed-by=opencode-rc-e2e`) and deploys; `make down` deletes the namespace only when it carries that label, and otherwise removes just what Skaffold deployed. Use a different `NAMESPACE` for concurrent runs on one cluster.

The test environment deploys:
- The Helm chart (api, ui, gateway, redis, oidc-mock) with `local` profile
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

E2e targets use `KUBE_CONTEXT` (default: the current kubectl context) and `NAMESPACE` (default: `opencode-rc`) and pass both explicitly to every command. Never create or delete clusters from scripts; clean up by deleting the namespace (`make down`).
