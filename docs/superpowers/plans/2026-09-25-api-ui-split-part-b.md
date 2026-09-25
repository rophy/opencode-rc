# API/UI Split, Part B: Separate UI Image and Hostname — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API image and host serve no HTML; the SPA ships in its own nginx image on its own hostname, configured with the API URL at runtime.

**Architecture:** `ui/` builds `ui/dist` once; `ui/web/` packages it with nginx-unprivileged and writes `config.json` from `API_URL` at container start. The API drops its SPA handler and answers every non-API path with a JSON 404. The chart gains a `ui` component and wires `API_URL` and `ALLOWED_ORIGINS` between the two public URLs.

**Tech Stack:** Bun + Hono (api), nginx-unprivileged alpine, Helm + helm-unittest, GitHub Actions, kind + Skaffold e2e.

**Spec:** `docs/superpowers/specs/2026-09-25-api-ui-split-design.md` (section "Part B")

**Prerequisite:** Part A (`docs/superpowers/plans/2026-09-25-api-rename-part-a.md`) is complete: `api/`, chart values `api.*`, resources `<fullname>-api`, e2e `API_URL`.

## Global Constraints

- The API host serves no HTML: every path other than `/healthz`, `/api/*`, `/auth/*`, `/gateway/*`, `/proxy/*` returns `404 {"error":"not found"}`.
- UI image: `nginxinc/nginx-unprivileged:alpine`, listens on 8080, image `ghcr.io/<repo>/ui`, version from `ui/package.json` (currently `0.5.0`).
- UI runtime config: `/config.json` = `{"serverUrl":"<API_URL>"}` written at container start from env `API_URL`; start fails if `API_URL` is unset or invalid.
- Chart: values `ui.*` (with `ui.enabled`, default `true`); resources `<fullname>-ui`, component label `ui`; `API_URL` = api public URL; api `ALLOWED_ORIGINS` includes the ui public URL; `helm template` fails when both ingresses are enabled with the same host.
- Public URL rule: `https://<host>` if that component's ingress is enabled with a host and has TLS; `http://<host>` if enabled without TLS; else `http://<fullname>-<component>:8080`.
- No changes to SPA code in `ui/src` (it already reads `config.json` and uses bearer auth cross-origin).
- Commit messages `<type>: <description>`, no attribution lines, no mention of Claude. Never push. Never use bare `git stash`. Never edit `vendor/` or `docs/superpowers/`.
- Package managers: `api/`, `ui/` bun; `cli/`, `e2e/` npm. kubectl context for e2e: `kind-opencode-rc-e2e` only.

---

### Task 1: API serves no UI

**Files:**
- Modify: `api/Dockerfile`, `api/src/index.ts`, `api/src/config.ts`, `api/src/config.test.ts`
- Delete: `api/src/webui.ts`, `api/src/webui.test.ts`
- Create: `api/src/not-found.ts`, `api/src/not-found.test.ts`
- Modify: any other `api/src/*.test.ts` that sets `webUiDir` in a Config object (find with `git grep -n webUiDir api/src`)

**Interfaces:**
- Produces: `notFoundJson(): NotFoundHandler` (Hono) returning `404 {"error":"not found"}`.

- [ ] **Step 1: Write the failing test**

`api/src/not-found.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { notFoundJson } from "./not-found.js";

describe("notFoundJson", () => {
  const app = new Hono();
  app.get("/api/me", (c) => c.json({ ok: true }));
  app.notFound(notFoundJson());

  it("answers every unknown path with a JSON 404, never HTML", async () => {
    for (const path of ["/", "/index.html", "/s/alice-dev/", "/s/alice-dev/abc/session/ses_1", "/assets/app.js", "/api/nope"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  it("leaves known routes alone", async () => {
    const res = await app.request("/api/me");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && npx vitest run src/not-found.test.ts`
Expected: FAIL, cannot resolve `./not-found.js`.

- [ ] **Step 3: Implement**

`api/src/not-found.ts`:

```ts
import type { NotFoundHandler } from "hono";

// The API host serves no HTML: anything that is not an API route is a JSON 404.
export function notFoundJson(): NotFoundHandler {
  return (c) => c.json({ error: "not found" }, 404);
}
```

In `api/src/index.ts`:
- remove the import of `spaHandler` / `reservedNotFound` from `./webui.js` and add `import { notFoundJson } from "./not-found.js";`
- delete the block

```ts
// Unknown API paths: JSON 404, never the SPA
app.all("*", reservedNotFound());

// SPA: static files, client routes (including /s/:id/...) fall back to index.html
if (config.webUiDir) {
  app.get("*", spaHandler(config.webUiDir));
}
```

  and put in its place

```ts
// The API host serves no HTML (the UI has its own image and host).
app.notFound(notFoundJson());
```

Delete the old module and its test:

```bash
git rm api/src/webui.ts api/src/webui.test.ts
```

In `api/src/config.ts` remove the `webUiDir: string;` field and the `webUiDir: process.env.WEBUI_DIR ?? "",` line. In `api/src/config.test.ts` remove `delete process.env.WEBUI_DIR;` and `expect(config.webUiDir).toBe("");`. Remove `webUiDir: "",` from every Config literal in other tests (`git grep -n webUiDir api/src` must return nothing).

In `api/Dockerfile` remove the whole first stage (`FROM oven/bun:1 AS ui` through `RUN cd ui && OPENCODE_ROOT=/src/vendor/opencode bun run build`), and the lines `COPY --from=ui /src/ui/dist /webui` and `ENV WEBUI_DIR=/webui`. The result:

```dockerfile
FROM oven/bun:1-slim
WORKDIR /app
COPY api/package.json api/bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production
COPY api/src/ src/
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
```

- [ ] **Step 4: Verify**

Run: `cd api && npx vitest run && npx tsc --noEmit -p .`
Expected: all pass, no type errors.

Run: `docker build -f api/Dockerfile -t opencode-rc-api:check . && docker run --rm opencode-rc-api:check ls / | grep -c webui`
Expected: build succeeds; count `0`.

- [ ] **Step 5: Commit**

```bash
git add -A api
git commit -m "feat(api): stop serving the UI; JSON 404 for every non-API path"
```

---

### Task 2: UI image (`ui/web/`)

**Files:**
- Create: `ui/web/Dockerfile`, `ui/web/nginx.conf`, `ui/web/40-rc-config.sh`, `ui/web/smoke-test.sh`
- Modify: `.dockerignore` at repo root if one exists and excludes `ui/` paths needed by the build (check first)

**Interfaces:**
- Produces: an image that serves `ui/dist` on 8080 with `/healthz`, `/config.json`, SPA fallback; env `API_URL` required.

- [ ] **Step 1: Write the smoke test first**

`ui/web/smoke-test.sh`:

```sh
#!/bin/sh
# Usage: ui/web/smoke-test.sh <image>
# Starts the UI image and checks routing, caching headers and runtime config.
set -eu
IMAGE="$1"
NAME="rc-ui-smoke-$$"
PORT="${SMOKE_PORT:-18089}"
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" >&2 2>/dev/null || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; exit 1; }

# Missing API_URL must fail the container start.
if docker run --rm "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: container started without API_URL" >&2; exit 1
fi
# Invalid API_URL must fail too.
if docker run --rm -e 'API_URL=https://x.example.com/"onload' "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: container started with an invalid API_URL" >&2; exit 1
fi

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -e API_URL=https://api.example.com/ "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done

B="http://127.0.0.1:$PORT"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/healthz")" = 200 ] || fail "/healthz"
curl -s "$B/config.json" | grep -qx '{"serverUrl":"https://api.example.com"}' || fail "/config.json content"
curl -sI "$B/config.json" | grep -qi '^cache-control: no-cache' || fail "/config.json cache-control"
curl -s "$B/" | grep -q '<div id="root"' || fail "/ is not index.html"
curl -s "$B/s/alice-dev/abc/session/ses_1" | grep -q '<div id="root"' || fail "SPA fallback"
curl -sI "$B/" | grep -qi '^cache-control: no-cache' || fail "index cache-control"
ASSET=$(curl -s "$B/" | grep -o '/assets/[^"]*\.js' | head -1)
[ -n "$ASSET" ] || fail "no asset referenced from index.html"
curl -sI "$B$ASSET" | grep -qi '^cache-control: public, max-age=31536000, immutable' || fail "asset cache-control"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/assets/nope.js")" = 404 ] || fail "missing asset should 404"
echo "UI image smoke test passed"
```

`chmod +x ui/web/smoke-test.sh`. Check what the root element in `ui/index.html` is (`grep -n 'id="root"' ui/index.html`) and adjust the `<div id="root"` pattern if the markup differs.

- [ ] **Step 2: Write the image**

`ui/web/Dockerfile` (build context = repo root):

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /src
COPY vendor/opencode/package.json vendor/opencode/bun.lock vendor/opencode/
COPY vendor/opencode/patches/ vendor/opencode/patches/
COPY vendor/opencode/packages/ vendor/opencode/packages/
RUN cd vendor/opencode && bun install --frozen-lockfile --ignore-scripts
COPY ui/package.json ui/bun.lock ui/
RUN cd ui && bun install --frozen-lockfile
COPY ui/ ui/
RUN cd ui && OPENCODE_ROOT=/src/vendor/opencode bun run build

FROM nginxinc/nginx-unprivileged:alpine
COPY ui/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 ui/web/40-rc-config.sh /docker-entrypoint.d/40-rc-config.sh
COPY --from=build /src/ui/dist /usr/share/nginx/html
EXPOSE 8080
```

(The first stage is the one removed from the API Dockerfile in Task 1; `COPY ui/ ui/` also copies `ui/web/`, `ui/ios` and `ui/android`, which is harmless but slow — add a root `.dockerignore` entry list only if the build context becomes a problem; do not ignore paths the API or gateway Dockerfiles need.)

`ui/web/nginx.conf`:

```nginx
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    location = /config.json {
        alias /tmp/rc-config/config.json;
        default_type application/json;
        add_header Cache-Control "no-cache" always;
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    location / {
        add_header Cache-Control "no-cache" always;
        try_files $uri /index.html;
    }
}
```

`ui/web/40-rc-config.sh` (the official nginx entrypoint runs `/docker-entrypoint.d/*.sh` before starting nginx and stops on a non-zero exit):

```sh
#!/bin/sh
# Writes the UI's runtime config from API_URL. The API host is chosen per deployment,
# so one image serves every environment.
set -eu
if [ -z "${API_URL:-}" ]; then
  echo "40-rc-config: API_URL is required" >&2
  exit 1
fi
case "$API_URL" in
  http://*|https://*) ;;
  *) echo "40-rc-config: API_URL must start with http:// or https://" >&2; exit 1 ;;
esac
case "$API_URL" in
  *[!A-Za-z0-9:/._-]*) echo "40-rc-config: API_URL contains unsupported characters" >&2; exit 1 ;;
esac
mkdir -p /tmp/rc-config
printf '{"serverUrl":"%s"}\n' "${API_URL%/}" > /tmp/rc-config/config.json
```

- [ ] **Step 3: Build and run the smoke test**

Run: `docker build -f ui/web/Dockerfile -t opencode-rc-ui:check . && ui/web/smoke-test.sh opencode-rc-ui:check`
Expected: `UI image smoke test passed`. If the entrypoint does not abort nginx on the script's non-zero exit, check the base image's `/docker-entrypoint.sh` (`docker run --rm --entrypoint cat opencode-rc-ui:check /docker-entrypoint.sh`) and make the failure fatal (for example by exiting the container from the script with `kill 1` is NOT acceptable; instead rely on `set -e` in the entrypoint, or move the check into a wrapper `ENTRYPOINT`). Keep the smoke test's two negative checks passing.

- [ ] **Step 4: Commit**

```bash
git add ui/web
git commit -m "feat(ui): add nginx image serving ui/dist with runtime API URL"
```

---

### Task 3: Chart `ui` component and URL wiring

**Files:**
- Modify: `charts/opencode-rc/values.yaml`, `templates/_helpers.tpl`, `templates/api-deployment.yaml`, `templates/NOTES.txt`
- Create: `templates/ui-deployment.yaml`, `templates/ui-service.yaml`, `templates/ui-ingress.yaml`
- Create: `tests/ui_deployment_test.yaml`, `tests/ui_service_test.yaml`, `tests/ui_ingress_test.yaml`
- Modify: `tests/api_deployment_test.yaml`

**Interfaces:**
- Produces: helpers `opencode-rc.apiPublicUrl`, `opencode-rc.uiPublicUrl`, `opencode-rc.validateHosts`; values `ui.*`.

- [ ] **Step 1: Values**

Add to `values.yaml` after the `api:` block:

```yaml
ui:
  # Serve the web UI from its own image and host. The API host never serves HTML.
  enabled: true
  image:
    registry: ""
    repository: ghcr.io/rophy/opencode-rc/ui
    tag: "0.5.0"
    pullPolicy: IfNotPresent
  replicas: 1
  resources: {}
  podAnnotations: {}
  podLabels: {}
  nodeSelector: {}
  tolerations: []
  affinity: {}
  securityContext: {}
  containerSecurityContext: {}
  service:
    type: ClusterIP
    nodePort: null
  ingress:
    enabled: false
    className: ""
    host: ""
    annotations: {}
    tls: []
```

- [ ] **Step 2: Failing chart tests**

`tests/ui_deployment_test.yaml`:

```yaml
suite: ui deployment
templates:
  - templates/ui-deployment.yaml
tests:
  - it: renders the ui deployment with the api URL from the service
    asserts:
      - equal:
          path: metadata.name
          value: RELEASE-NAME-opencode-rc-ui
      - equal:
          path: spec.template.spec.containers[0].image
          value: ghcr.io/rophy/opencode-rc/ui:0.5.0
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: API_URL
            value: http://RELEASE-NAME-opencode-rc-api:8080

  - it: uses https api URL when the api ingress has TLS
    set:
      api.ingress.enabled: true
      api.ingress.host: api.rc.example.com
      api.ingress.tls:
        - hosts: [api.rc.example.com]
          secretName: api-tls
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: API_URL
            value: https://api.rc.example.com

  - it: uses http api URL when the api ingress has no TLS
    set:
      api.ingress.enabled: true
      api.ingress.host: api.rc.example.com
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: API_URL
            value: http://api.rc.example.com

  - it: is not rendered when ui is disabled
    set:
      ui.enabled: false
    asserts:
      - hasDocuments:
          count: 0
```

`tests/ui_service_test.yaml`:

```yaml
suite: ui service
templates:
  - templates/ui-service.yaml
tests:
  - it: exposes port 8080
    asserts:
      - equal:
          path: metadata.name
          value: RELEASE-NAME-opencode-rc-ui
      - equal:
          path: spec.ports[0].port
          value: 8080
  - it: is not rendered when ui is disabled
    set:
      ui.enabled: false
    asserts:
      - hasDocuments:
          count: 0
```

`tests/ui_ingress_test.yaml`:

```yaml
suite: ui ingress
templates:
  - templates/ui-ingress.yaml
tests:
  - it: routes the ui host to the ui service
    set:
      ui.ingress.enabled: true
      ui.ingress.host: rc.example.com
    asserts:
      - equal:
          path: spec.rules[0].host
          value: rc.example.com
      - equal:
          path: spec.rules[0].http.paths[0].backend.service.name
          value: RELEASE-NAME-opencode-rc-ui

  - it: refuses the same host as the api
    set:
      ui.ingress.enabled: true
      ui.ingress.host: rc.example.com
      api.ingress.enabled: true
      api.ingress.host: rc.example.com
    asserts:
      - failedTemplate:
          errorMessage: "ui.ingress.host must differ from api.ingress.host: the API host must not serve the UI"
```

Append to `tests/api_deployment_test.yaml`:

```yaml
  - it: allows the ui origin (service URL) by default
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: ALLOWED_ORIGINS
            value: http://RELEASE-NAME-opencode-rc-ui:8080

  - it: allows the ui ingress origin plus extra origins
    set:
      ui.ingress.enabled: true
      ui.ingress.host: rc.example.com
      ui.ingress.tls:
        - hosts: [rc.example.com]
          secretName: ui-tls
      auth.allowedOrigins:
        - https://other.example.com
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: ALLOWED_ORIGINS
            value: https://rc.example.com,https://other.example.com

  - it: omits ALLOWED_ORIGINS when ui is disabled and no extras are set
    set:
      ui.enabled: false
    asserts:
      - notContains:
          path: spec.template.spec.containers[0].env
          content:
            name: ALLOWED_ORIGINS
          any: true
```

Update the existing `sets ALLOWED_ORIGINS when configured` test in `api_deployment_test.yaml`: with `ui.enabled` defaulting to true the expected value is now `http://RELEASE-NAME-opencode-rc-ui:8080,https://a.example.com,https://b.example.com`.

Run: `helm unittest charts/opencode-rc`
Expected: FAIL (templates missing).

- [ ] **Step 3: Helpers**

Add to `templates/_helpers.tpl`:

```
{{/*
Public URL of a component: https://<host> with ingress+TLS, http://<host> with ingress,
else the in-cluster service URL.
*/}}
{{- define "opencode-rc.apiPublicUrl" -}}
{{- if and .Values.api.ingress.enabled .Values.api.ingress.host -}}
{{ if .Values.api.ingress.tls }}https{{ else }}http{{ end }}://{{ .Values.api.ingress.host }}
{{- else -}}
http://{{ include "opencode-rc.fullname" . }}-api:8080
{{- end -}}
{{- end -}}

{{- define "opencode-rc.uiPublicUrl" -}}
{{- if and .Values.ui.ingress.enabled .Values.ui.ingress.host -}}
{{ if .Values.ui.ingress.tls }}https{{ else }}http{{ end }}://{{ .Values.ui.ingress.host }}
{{- else -}}
http://{{ include "opencode-rc.fullname" . }}-ui:8080
{{- end -}}
{{- end -}}

{{- define "opencode-rc.validateHosts" -}}
{{- if and .Values.ui.ingress.enabled .Values.api.ingress.enabled (eq .Values.ui.ingress.host .Values.api.ingress.host) -}}
{{- fail "ui.ingress.host must differ from api.ingress.host: the API host must not serve the UI" -}}
{{- end -}}
{{- end -}}
```

Rewrite the non-explicit branches of `opencode-rc.redirectUri` to reuse it (behaviour unchanged): keep the explicit `oidc.redirectUri` branch, otherwise `{{ include "opencode-rc.apiPublicUrl" . }}/auth/callback`.

- [ ] **Step 4: Templates**

`templates/ui-deployment.yaml`:

```yaml
{{- if .Values.ui.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "opencode-rc.fullname" . }}-ui
  labels:
    {{- include "opencode-rc.labels" . | nindent 4 }}
    app.kubernetes.io/component: ui
spec:
  replicas: {{ .Values.ui.replicas }}
  selector:
    matchLabels:
      {{- include "opencode-rc.selectorLabels" . | nindent 6 }}
      app.kubernetes.io/component: ui
  template:
    metadata:
      labels:
        {{- include "opencode-rc.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: ui
        {{- with .Values.ui.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- with .Values.ui.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.ui.securityContext }}
      securityContext:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: ui
          image: {{ include "opencode-rc.image" (dict "image" .Values.ui.image "global" .Values.global) }}
          imagePullPolicy: {{ .Values.ui.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: API_URL
              value: {{ include "opencode-rc.apiPublicUrl" . | quote }}
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
          {{- with .Values.ui.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.ui.containerSecurityContext }}
          securityContext:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      {{- with .Values.ui.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.ui.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.ui.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end }}
```

`templates/ui-service.yaml`: copy `templates/api-service.yaml`, wrap it in `{{- if .Values.ui.enabled }} ... {{- end }}`, and replace `-api` with `-ui`, `component: api` with `component: ui`, `.Values.api.service` with `.Values.ui.service`.

`templates/ui-ingress.yaml`: copy `templates/api-ingress.yaml`, change the guard to `{{- if and .Values.ui.enabled .Values.ui.ingress.enabled }}`, add `{{- include "opencode-rc.validateHosts" . }}` as the first line inside the guard, and replace `.Values.api.ingress` with `.Values.ui.ingress`, `-api` with `-ui` (name and backend service), `component: api` with `component: ui`.

In `templates/api-deployment.yaml`, replace the `ALLOWED_ORIGINS` block

```yaml
            {{- with (dig "allowedOrigins" list $auth) }}
            - name: ALLOWED_ORIGINS
              value: {{ join "," . | quote }}
            {{- end }}
```

with

```yaml
            {{- $origins := dig "allowedOrigins" list $auth }}
            {{- if .Values.ui.enabled }}
            {{- $origins = prepend $origins (include "opencode-rc.uiPublicUrl" .) }}
            {{- end }}
            {{- with $origins }}
            - name: ALLOWED_ORIGINS
              value: {{ join "," . | quote }}
            {{- end }}
```

In `templates/NOTES.txt`, after the API URL lines add the UI URL: when `.Values.ui.enabled`, print `UI URL: {{ include "opencode-rc.uiPublicUrl" . }}` and, without ingress, the port-forward hint `kubectl port-forward svc/{{ include "opencode-rc.fullname" . }}-ui 8081:8080`.

- [ ] **Step 5: Verify**

Run: `helm unittest charts/opencode-rc && helm lint charts/opencode-rc`
Expected: all pass (update snapshots with `-u` only if they differ solely by the new ui resources, and review the diff).

Run: `helm template t charts/opencode-rc --set ui.ingress.enabled=true --set ui.ingress.host=a --set api.ingress.enabled=true --set api.ingress.host=a`
Expected: fails with the validateHosts message.

- [ ] **Step 6: Commit**

```bash
git add charts/opencode-rc
git commit -m "feat(chart): add ui component on its own host and wire API_URL/ALLOWED_ORIGINS"
```

---

### Task 4: CI

**Files:**
- Create: `.github/workflows/ui.yml`
- Modify: `.github/workflows/api.yml` (path filters), `.github/workflows/e2e.yml` (path filters)

- [ ] **Step 1: `ui.yml`**

Create `.github/workflows/ui.yml`:

```yaml
name: UI

on:
  push:
    branches: [main]
    paths:
      - 'ui/**'
      - 'vendor/opencode'
      - '.github/workflows/ui.yml'
  pull_request:
    paths:
      - 'ui/**'
      - 'vendor/opencode'
      - '.github/workflows/ui.yml'
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          submodules: true
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: cd vendor/opencode && bun install --frozen-lockfile --ignore-scripts
      - run: cd ui && bun install --frozen-lockfile && bun run test

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          submodules: true
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v4
      - name: Build ui image
        uses: docker/build-push-action@v7
        with:
          context: .
          file: ui/web/Dockerfile
          push: false
          load: true
          tags: opencode-rc-ui:test
          cache-from: type=gha,scope=ui
          cache-to: type=gha,mode=max,scope=ui
      - name: Smoke test ui image
        run: ui/web/smoke-test.sh opencode-rc-ui:test

  publish:
    needs: [test, build]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      packages: write
      contents: write
    steps:
      - uses: actions/checkout@v5
        with:
          submodules: true

      - name: Check if version exists on ghcr.io
        id: check
        run: |
          VERSION=$(node -p "require('./ui/package.json').version")
          if docker manifest inspect ghcr.io/${{ github.repository }}/ui:$VERSION > /dev/null 2>&1; then
            echo "publish=false" >> "$GITHUB_OUTPUT"
            echo "UI $VERSION already exists, skipping publish"
          else
            echo "publish=true" >> "$GITHUB_OUTPUT"
            echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          fi

      - name: Set up Docker Buildx
        if: steps.check.outputs.publish == 'true'
        uses: docker/setup-buildx-action@v4

      - name: Log in to ghcr.io
        if: steps.check.outputs.publish == 'true'
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push ui
        if: steps.check.outputs.publish == 'true'
        uses: docker/build-push-action@v7
        with:
          context: .
          file: ui/web/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository }}/ui:${{ steps.check.outputs.version }}
            ghcr.io/${{ github.repository }}/ui:latest
          cache-from: type=gha,scope=ui
          cache-to: type=gha,mode=max,scope=ui

      - name: Tag release
        if: steps.check.outputs.publish == 'true'
        run: |
          git config user.name "github-actions"
          git config user.email "github-actions@github.com"
          git tag "ui/${{ steps.check.outputs.version }}"
          git push origin "ui/${{ steps.check.outputs.version }}"
```

Check first whether `ui` has a `test` script (`grep -n '"test"' ui/package.json`); if not, use `npx vitest run` in the test job instead of `bun run test`.

- [ ] **Step 2: `api.yml` path filters**

In `.github/workflows/api.yml` remove the `- 'ui/**'` and `- 'vendor/opencode'` path filters (both `push` and `pull_request`), and remove `with: submodules: true` from the `build` and `publish` checkouts (the API image no longer builds the UI).

- [ ] **Step 3: `e2e.yml` path filters**

Add `- 'ui/**'` to both path filter lists in `.github/workflows/e2e.yml` if it is not already there.

- [ ] **Step 4: Verify**

Run: `for f in .github/workflows/*.yml; do python3 -c "import yaml,sys; yaml.safe_load(open('$f'))" && echo "ok $f"; done`
Expected: `ok` for every workflow.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows
git commit -m "ci: build, smoke-test and publish the ui image; api no longer builds the UI"
```

---

### Task 5: e2e and docs

**Files:**
- Modify: `e2e/skaffold.yaml`, `e2e/playwright.config.ts`, `e2e/e2e.test.ts`, `Makefile` (`up`, `e2e-test`), `.github/workflows/e2e.yml`
- Modify: `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `DESIGN.md`, `docs/ios-app.md`, `.claude/skills/check-versions.md`

**Interfaces:**
- Consumes: UI image (Task 2), chart `ui.*` (Task 3), API JSON 404 (Task 1).

- [ ] **Step 1: Skaffold**

In `e2e/skaffold.yaml` add the artifact

```yaml
    - image: opencode-rc-ui
      context: ..
      docker:
        dockerfile: ui/web/Dockerfile
```

(place it after `opencode-rc-api`; if the `dev` profile patches reference artifacts by index, e.g. `/build/artifacts/1/...` for the gateway, update the indexes so they still point at the gateway), `ui.image.pullPolicy: Never` under `setValues`, and under `setValueTemplates`:

```yaml
          ui.image.registry: ""
          ui.image.repository: "{{.IMAGE_REPO_opencode_rc_ui}}"
          ui.image.tag: "{{.IMAGE_TAG_opencode_rc_ui}}"
```

- [ ] **Step 2: Playwright goes through the UI host**

`e2e/playwright.config.ts` baseURL:

```ts
    baseURL: process.env.UI_URL || "http://opencode-rc-ui:8080",
```

`Makefile`: in `up`, after waiting for `deployment/opencode-rc-api`, add `@$(KUBECTL) wait --for=condition=Available deployment/opencode-rc-ui --timeout=120s`; in `e2e-test`, change the vitest line to also pass `UI_URL=http://opencode-rc-ui:8080` and the Playwright line from `API_URL=http://opencode-rc-api:8080 npx playwright test` to `UI_URL=http://opencode-rc-ui:8080 npx playwright test`.

`.github/workflows/e2e.yml`: add a `Wait for ui` step (`kubectl wait --for=condition=Available deployment/opencode-rc-ui --timeout=120s`) and the same `UI_URL` env changes on the two test lines.

- [ ] **Step 3: e2e tests for the split**

In `e2e/e2e.test.ts` add `const UI_URL = process.env.UI_URL ?? "http://opencode-rc-ui:8080";` next to `API_URL`, replace the existing "web UI serving" describe block (which expects the API to serve the SPA) with:

```ts
describe("API and UI are separate hosts", () => {
  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    await waitFor("ui", `${UI_URL}/healthz`, 30);
  });

  it("the API host serves no HTML", async () => {
    for (const path of ["/", "/index.html", `/s/${SESSION_ID}/`, "/assets/app.js"]) {
      const res = await fetch(`${API_URL}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
    }
  });

  it("the UI host serves the SPA for client routes", async () => {
    const res = await fetch(`${UI_URL}/s/${SESSION_ID}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("<html");
  });

  it("the UI is configured with the API URL", async () => {
    const res = await fetch(`${UI_URL}/config.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ serverUrl: API_URL });
  });

  it("the API allows the UI origin", async () => {
    const res = await fetch(`${API_URL}/api/me`, {
      method: "OPTIONS",
      headers: {
        origin: UI_URL,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(UI_URL);
  });
});
```

The Playwright specs need no code change: they now run against the UI host, and the login flow goes UI host → API `/auth/start` (absolute `return_to` on the UI origin) → IdP → API callback → script navigation back to the UI host. The existing "login lands back on the page it started from" test covers the round trip.

- [ ] **Step 4: Full e2e**

Run: `./e2e/run.sh`
Expected: exit 0; vitest (previous 44 minus the removed SPA test, plus 4 new) all pass; Playwright 14/14; cluster deleted at the end. If the browser login fails, check `ALLOWED_ORIGINS` on the api deployment (`kubectl --context kind-opencode-rc-e2e get deploy opencode-rc-api -o jsonpath='{..env}'`) includes `http://opencode-rc-ui:8080`.

- [ ] **Step 5: Docs**

- `AGENTS.md` / `CONTRIBUTING.md` project structure: add `ui/web/        # nginx image packaging for ui/dist (Dockerfile, nginx.conf, runtime config)`; change the `api/` description to "API server: OIDC auth, tokens, proxy to gateway (serves no UI)"; replace "Output: `ui/dist/` — static SPA served by the web server via `WEBUI_DIR`" with "Output: `ui/dist/` — consumed by the UI image (`ui/web/`), the iOS project and the Android project".
- `README.md`: architecture/component table adds the UI image; values table adds `ui.enabled`, `ui.ingress.enabled`, `ui.ingress.host`; image table adds `ghcr.io/rophy/opencode-rc/ui`. Add an "Upgrading to 0.6" section: chart values `web.*` renamed to `api.*`; set `ui.ingress.host` to a hostname different from `api.ingress.host`; the API host no longer serves the UI (old bookmarks there return 404); use `helm upgrade --reset-then-reuse-values` (or pass a full values file) because value keys were renamed; everyone is logged out once (bearer tokens).
- `DESIGN.md`: API server no longer "Serves the SPA"; add the UI image as a component.
- `docs/ios-app.md`: the app is configured with the API host (which serves no HTML).
- `.claude/skills/check-versions.md`: API no longer bundles the UI (remove that note and the `ui/**`, `vendor/opencode` triggers from the API row); add a row `| **UI** | \`ui/package.json\` | ghcr.io docker image | \`.github/workflows/ui.yml\` | \`ui/**\`, \`vendor/opencode\` |`; the chart pins `ui.image.tag` too.

Run: `git grep -n "WEBUI_DIR\|webUiDir\|spaHandler\|served by the web server" -- ':!docs/superpowers' ':!vendor'`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add e2e Makefile .github/workflows/e2e.yml README.md CONTRIBUTING.md AGENTS.md DESIGN.md docs/ios-app.md .claude/skills/check-versions.md
git commit -m "test(e2e): run the browser against the UI host; docs for the API/UI split"
```
