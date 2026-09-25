# Split the API Server and the Web UI

Date: 2026-09-25
Status: Draft, pending review
Builds on: `2026-09-24-bearer-token-auth-design.md` (bearer tokens, CORS, `/proxy/:id`)

## Problem

The `web/` image bundles two things: the Bun API server and the SPA (built into
`/webui` and served by a catch-all SPA handler). The mobile app ships its own copy of
the SPA and talks to the server cross-origin, but because the server's hostname also
serves the SPA, any stray navigation of the app's WebView to the server origin (for
example a redirect to `/`) silently loads the server's copy of the UI instead of the
bundled one. That happened before the bearer-token work, and nothing structural stops
it from happening again.

The directory and image names add confusion: top-level `web/` is the API server, while
"web UI" means the SPA in `ui/`.

## Goals

- The hostname the mobile app talks to serves no HTML at all, so the app physically
  cannot load a server-hosted UI.
- The SPA is built once (`ui/dist`) and consumed by three deliverables: the web UI
  image, the iOS project and the Android project.
- Names say what things are: `api` for the server, `ui` for the SPA and its packaging.

## Non-goals

- Changes to the SPA's code or behaviour (it already supports a configured server URL
  and cross-origin bearer auth).
- Native navigation policy for iOS/Android (separate follow-up).
- A mode where the API also serves the UI. Deliberately dropped: it is exactly what this
  change rules out.

## Decisions

| Topic | Decision |
|---|---|
| Hostnames | Separate: UI on `ui.ingress.host`, API on `api.ingress.host`. The API host serves no HTML. |
| UI server | `nginxinc/nginx-unprivileged` (alpine), static files only |
| API URL for the UI | Runtime: container entrypoint writes `/config.json` (`{"serverUrl": "<API_URL>"}`) from the `API_URL` env var; one image for all environments |
| Names | Directory `api/`, image `ghcr.io/<repo>/api`, chart values `api.*`, resources `<fullname>-api`; UI image `ghcr.io/<repo>/ui`, chart values `ui.*`, resources `<fullname>-ui` |
| Migration | Breaking change, documented; ships in the same release as bearer-token auth (all users re-login anyway) |
| Delivery | Two parts in order: A (rename, no behaviour change), then B (split). Each ends with a green `make unit-test` and `./e2e/run.sh`. |

## Target layout

```
api/                 Bun server (was web/)
gateway/
cli/
ui/
  src/, vite.config.ts, package.json   bun run build -> ui/dist
  capacitor.config.ts                  webDir: "dist" (unchanged)
  web/                                 UI image packaging only: Dockerfile, nginx.conf, entrypoint
  ios/                                 Xcode project   (npx cap sync copies ui/dist in)
  android/                             Gradle project  (npx cap sync copies ui/dist in)
charts/opencode-rc/
e2e/
vendor/opencode
```

`ui/web/` contains no application code. All three deliverables ship the same `ui/dist`.

## Part A: rename `web` to `api` (no behaviour change)

| Before | After |
|---|---|
| `web/` | `api/` (git mv; package name `@opencode-rc/api`) |
| image `ghcr.io/<repo>/web` | `ghcr.io/<repo>/api` |
| chart values `web.*` | `api.*` |
| templates `web-deployment.yaml`, `web-service.yaml`, `web-ingress.yaml` | `api-*.yaml` |
| chart tests `web_*_test.yaml` | `api_*_test.yaml` |
| resources `<fullname>-web`, component label `web` | `<fullname>-api`, component `api` |
| in-cluster URL `http://opencode-rc-web:8080` | `http://opencode-rc-api:8080` |
| helper `opencode-rc.redirectUri` using `web.ingress.*` / `<fullname>-web` | `api.ingress.*` / `<fullname>-api` |
| CI `.github/workflows/web.yml`, tags `web/x.y.z` | `api.yml`, tags `api/x.y.z`; version continues from 0.6.0 |
| e2e env `WEB_URL`, Skaffold artifact `opencode-rc-web` | `API_URL`, `opencode-rc-api` |

Also updated: `Makefile` (unit-test target, kubectl waits), `e2e/skaffold.yaml`,
`e2e/tls-ca.test.ts`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `docs/ios-app.md`,
`.claude/skills/check-versions.md`, and any other `web/` path references found by
`grep -rn "web/\|opencode-rc-web\|\.Values\.web\|WEB_URL"`.

In Part A the API image still bundles the SPA and serves it (behaviour unchanged).

Done when `make unit-test` and `./e2e/run.sh` pass with only path and name changes to
tests.

## Part B: separate UI image and hostname

### API server (`api/`)

- `api/Dockerfile`: remove the UI build stage, `COPY --from=ui`, and `WEBUI_DIR`.
- `api/src`: remove `spaHandler`, `resolveSpaFile` and the `webUiDir` config. Every path
  that is not `/healthz`, `/api/*`, `/auth/*`, `/gateway/*`, `/proxy/*` returns
  `404 {"error":"not found"}`.
- `/auth/callback`: return-to targets are now always absolute in deployments (the UI is on
  its own host), so the existing script-navigation page is used for them. The relative
  `return_to` path stays supported for local dev (Vite dev server proxying to the API).

### UI image (`ui/web/`)

- `ui/web/Dockerfile`, build context = repo root:
  - stage 1 (`oven/bun`): install `vendor/opencode` and `ui` dependencies, `bun run build`
    in `ui/` (the stage moved out of the old web Dockerfile);
  - stage 2 (`nginxinc/nginx-unprivileged:alpine`): copy `ui/dist` to
    `/usr/share/nginx/html`, `nginx.conf`, and the entrypoint script; listen on 8080.
- `ui/web/nginx.conf`: `try_files $uri /index.html`; `Cache-Control: no-cache` for
  `index.html` and `config.json`; long-lived immutable caching for `/assets/*`; a
  `/healthz` location returning 200.
- `ui/web/entrypoint.sh` (run via nginx's `/docker-entrypoint.d/`): writes
  `/usr/share/nginx/html/config.json` as `{"serverUrl": "<API_URL>"}`. Fails the
  container start if `API_URL` is unset. The html directory must be writable by the
  unprivileged user (or config.json written to a writable path that nginx serves at
  `/config.json`).

### Chart

- New `ui:` values block mirroring `api:` (image, replicas, resources, scheduling,
  security contexts, `service`, `ingress.{enabled,className,host,annotations,tls}`),
  plus `ui.enabled` (default `true`).
- New templates `ui-deployment.yaml`, `ui-service.yaml`, `ui-ingress.yaml` and their tests.
- New helpers:
  - `opencode-rc.apiPublicUrl`: `https://<api.ingress.host>` if api ingress has TLS,
    `http://<host>` if ingress without TLS, else `http://<fullname>-api:8080`.
  - `opencode-rc.uiPublicUrl`: same rule for `ui.ingress` / `<fullname>-ui`.
- UI deployment env `API_URL` = `apiPublicUrl`.
- API deployment `ALLOWED_ORIGINS` = `uiPublicUrl` (when `ui.enabled`) joined with
  `auth.allowedOrigins`.
- Validation: if both ingresses are enabled and `ui.ingress.host == api.ingress.host`,
  `helm template` fails with a clear message.

### CI

- New `.github/workflows/ui.yml` modelled on `api.yml`: build `ui/web/Dockerfile` on PRs,
  push `ghcr.io/<repo>/ui:<version>` from main when the version in `ui/package.json` is
  new. Path filters include `ui/**` and `vendor/opencode`.
- `ios.yml` unchanged apart from any path filter touched by Part A.

### e2e

- Skaffold builds and deploys the `ui` image as part of the chart.
- Playwright `baseURL` = the UI service (`http://opencode-rc-ui:8080`); the SPA reaches the
  API at `http://opencode-rc-api:8080` via `config.json`.
- vitest keeps calling the API directly (`API_URL`).
- New tests: the API returns 404 JSON (not HTML) for `/`, `/s/<id>/`, `/index.html`; the UI
  service serves `index.html` for `/s/<id>/...` and `config.json` with the API URL; the
  browser login from the UI host lands back on the UI host logged in.

### Docs and release notes

- `README.md` / `CONTRIBUTING.md` / `AGENTS.md`: two hostnames, new chart values, UI image.
- `docs/ios-app.md`: the app is configured with the API host.
- Release notes (breaking): chart values renamed `web.*` → `api.*`; new required
  `ui.ingress.host` when ingress is enabled; the API host no longer serves the UI, so old
  bookmarks on it return 404; image `web` replaced by `api` and `ui`.

## Error handling

| Situation | Behaviour |
|---|---|
| UI container without `API_URL` | Entrypoint exits non-zero; pod fails to start (visible in `kubectl describe`) |
| Browser opens the API host | `404 {"error":"not found"}` for any non-API path |
| UI origin missing from `ALLOWED_ORIGINS` (e.g. hand-edited values) | `/auth/start` returns 400 for the UI's `return_to`; CORS preflight fails. Prevented by the chart wiring. |
| Same host for UI and API | `helm template` fails |

## Testing

- Part A: existing unit, chart and e2e suites pass with renamed paths only.
- Part B:
  - api unit tests: 404 JSON for non-API paths (replacing SPA tests); no `WEBUI_DIR`.
  - chart unit tests: ui deployment/service/ingress, `API_URL` and `ALLOWED_ORIGINS`
    wiring for ingress-with-TLS, ingress-without-TLS and no-ingress, same-host validation,
    `ui.enabled: false`.
  - UI image: a container smoke test in CI (start with `API_URL`, fetch `/`, `/s/x/`,
    `/config.json`, `/assets/<file>`, `/healthz`).
  - e2e as listed above; full `./e2e/run.sh` green.
  - Manual: dev cluster with two exposed hostnames, browser login and the Android app
    against the API host.
