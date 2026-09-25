# API/UI Split, Part A: Rename `web` to `api` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the API server from `web` to `api` everywhere (directory, package, image, chart values, Kubernetes resources, CI, e2e, docs) with no behaviour change.

**Architecture:** Pure rename in three reviewable steps: code/build/CI, then chart plus runtime names (resource names and in-cluster URLs change together), then docs. In Part A the API image still bundles and serves the SPA.

**Tech Stack:** Bun + Hono (api), Helm chart with helm-unittest, GitHub Actions, kind + Skaffold e2e (vitest + Playwright).

**Spec:** `docs/superpowers/specs/2026-09-25-api-ui-split-design.md` (section "Part A")

## Global Constraints

- New names: directory `api/`, package `@opencode-rc/api`, image `ghcr.io/<repo>/api`, chart values `api.*`, resources `<fullname>-api`, component label `api`, in-cluster URL `http://opencode-rc-api:8080`, CI workflow `.github/workflows/api.yml`, git tags `api/x.y.z`, e2e env `API_URL`, Skaffold artifact `opencode-rc-api`.
- The version continues from `0.6.0` (no version bump in Part A).
- No behaviour change: the only test edits allowed are paths and names.
- Do NOT rename `web` where it means something else: `solid-js/web`, `platform: "web"` (ui/src/entry.tsx), `ui/bun.lock`, "web UI"/"web interface" prose meaning the browser UI, `web.yml` history in docs/superpowers.
- Never edit files under `docs/superpowers/` or `vendor/`.
- Package managers: `api/` and `ui/` use bun; `cli/` and `e2e/` use npm.
- Commit messages `<type>: <description>`, no attribution lines, no mention of Claude. Never push. Never use bare `git stash`.
- kubectl context for e2e: `kind-opencode-rc-e2e` only.

---

### Task 1: Move the server to `api/` (code, build, CI)

**Files:**
- Move: `web/` → `api/` (git mv)
- Modify: `api/package.json`, `api/Dockerfile`, `api/src/index.ts`, `Makefile` (unit-test target), `e2e/skaffold.yaml` (artifact only)
- Move + modify: `.github/workflows/web.yml` → `.github/workflows/api.yml`
- Modify: `.github/workflows/e2e.yml` (path filters only)

**Interfaces:**
- Produces: directory `api/`; Skaffold artifact image name `opencode-rc-api` with template vars `IMAGE_REPO_opencode_rc_api` / `IMAGE_TAG_opencode_rc_api` (Task 2 wires them to `api.image.*`).

- [ ] **Step 1: Move the directory**

```bash
git mv web api
```

- [ ] **Step 2: Rename the package and fix paths inside the image build**

In `api/package.json` change `"name": "@opencode-rc/web"` to `"name": "@opencode-rc/api"`.

In `api/Dockerfile` change

```dockerfile
COPY web/package.json web/bun.lock* ./
```

to

```dockerfile
COPY api/package.json api/bun.lock* ./
```

and

```dockerfile
COPY web/src/ src/
```

to

```dockerfile
COPY api/src/ src/
```

In `api/src/index.ts` change the startup log `console.log(\`web starting version=${version} addr=:${config.port}\`);` to `console.log(\`api starting version=${version} addr=:${config.port}\`);`.

- [ ] **Step 3: Makefile unit-test target**

In `Makefile` change

```make
	@echo "=== Web (TypeScript) ==="
	@cd web && npx vitest run --coverage
```

to

```make
	@echo "=== API (TypeScript) ==="
	@cd api && npx vitest run --coverage
```

- [ ] **Step 4: Skaffold artifact**

In `e2e/skaffold.yaml`, in `build.artifacts`, change the first artifact to:

```yaml
    - image: opencode-rc-api
      context: ..
      docker:
        dockerfile: api/Dockerfile
```

and in `setValueTemplates` change only the template variable names (the keys stay `web.image.*` until Task 2):

```yaml
          web.image.registry: ""
          web.image.repository: "{{.IMAGE_REPO_opencode_rc_api}}"
          web.image.tag: "{{.IMAGE_TAG_opencode_rc_api}}"
```

- [ ] **Step 5: CI workflow**

```bash
git mv .github/workflows/web.yml .github/workflows/api.yml
```

In `.github/workflows/api.yml`:
- `name: Web` → `name: API`
- every `'web/**'` → `'api/**'`; every `'.github/workflows/web.yml'` → `'.github/workflows/api.yml'`
- `working-directory: web` → `working-directory: api`
- `file: web/Dockerfile` (twice) → `file: api/Dockerfile`
- `- name: Build web image` → `- name: Build api image`; `- name: Build and push web` → `- name: Build and push api`
- `tags: opencode-rc-web:test` → `tags: opencode-rc-api:test`
- `scope=web` (four times) → `scope=api`
- `require('./web/package.json')` → `require('./api/package.json')`
- `ghcr.io/${{ github.repository }}/web:` (three times) → `ghcr.io/${{ github.repository }}/api:`
- `echo "Web $VERSION already exists, skipping publish"` → `echo "API $VERSION already exists, skipping publish"`
- `git tag "web/${{ steps.check.outputs.version }}"` and `git push origin "web/${{ steps.check.outputs.version }}"` → `api/` prefix

Keep the `'ui/**'` and `'vendor/opencode'` path filters (in Part A the API image still bundles the UI).

In `.github/workflows/e2e.yml` change the two `- 'web/**'` path filters to `- 'api/**'`. Leave the kubectl/URL lines for Task 2.

- [ ] **Step 6: Verify**

Run: `make unit-test`
Expected: all suites pass; the header reads `=== API (TypeScript) ===`.

Run: `docker build -f api/Dockerfile -t opencode-rc-api:check .`
Expected: image builds.

Run: `git grep -nE "web/Dockerfile|web/package.json|cd web\b|'web/\*\*'|IMAGE_REPO_opencode_rc_web|workflows/web.yml" -- ':!docs/superpowers' ':!vendor'`
Expected: matches only in docs files handled by Task 3 (README.md, CONTRIBUTING.md, AGENTS.md, DESIGN.md, .claude/skills/check-versions.md); none in code, Makefile, Skaffold or workflows.

- [ ] **Step 7: Commit**

```bash
git add -A api .github/workflows Makefile e2e/skaffold.yaml
git commit -m "refactor: rename web server directory and image to api"
```

(`git add -A api` also records the removal of `web/`.)

---

### Task 2: Chart values, resource names and e2e runtime names

**Files:**
- Move: `charts/opencode-rc/templates/web-deployment.yaml` → `api-deployment.yaml`, `web-service.yaml` → `api-service.yaml`, `web-ingress.yaml` → `api-ingress.yaml`
- Move: `charts/opencode-rc/tests/web_deployment_test.yaml` → `api_deployment_test.yaml`, `web_service_test.yaml` → `api_service_test.yaml`, `web_ingress_test.yaml` → `api_ingress_test.yaml`
- Modify: `charts/opencode-rc/values.yaml`, `templates/_helpers.tpl`, `templates/NOTES.txt`, the three moved templates, the three moved tests, `tests/profile_validation_test.yaml`, any `tests/__snapshot__` files
- Modify: `e2e/skaffold.yaml`, `e2e/e2e.test.ts`, `e2e/playwright.config.ts`, `e2e/tls-ca.test.ts`, `Makefile` (`up` and `e2e-test` targets), `.github/workflows/e2e.yml`

**Interfaces:**
- Consumes: Skaffold artifact `opencode-rc-api` (Task 1).
- Produces: chart values `api.*`; resources `<fullname>-api` with label `app.kubernetes.io/component: api` and container name `api`; e2e env `API_URL` defaulting to `http://opencode-rc-api:8080`. Part B relies on these names.

- [ ] **Step 1: Move templates and tests**

```bash
cd charts/opencode-rc
git mv templates/web-deployment.yaml templates/api-deployment.yaml
git mv templates/web-service.yaml templates/api-service.yaml
git mv templates/web-ingress.yaml templates/api-ingress.yaml
git mv tests/web_deployment_test.yaml tests/api_deployment_test.yaml
git mv tests/web_service_test.yaml tests/api_service_test.yaml
git mv tests/web_ingress_test.yaml tests/api_ingress_test.yaml
cd ../..
```

- [ ] **Step 2: Rename inside the chart**

In the three `templates/api-*.yaml` files, `templates/_helpers.tpl` and `templates/NOTES.txt`:
- `.Values.web.` → `.Values.api.`
- `{{ include "opencode-rc.fullname" . }}-web` → `{{ include "opencode-rc.fullname" . }}-api` (resource names, the redirect-URI fallback in `_helpers.tpl`, the port-forward hint in NOTES.txt)
- `app.kubernetes.io/component: web` → `app.kubernetes.io/component: api`
- in `api-deployment.yaml`, the container `- name: web` → `- name: api`
- in NOTES.txt, the labels `Web URL:` → `API URL:` and `Web:` → `API:`
- in `_helpers.tpl`, the comment `auto-derived from web ingress` → `auto-derived from api ingress` and the usage example `.Values.web.image` → `.Values.api.image`

In `values.yaml`: the top-level key `web:` → `api:`, and `repository: ghcr.io/rophy/opencode-rc/web` → `repository: ghcr.io/rophy/opencode-rc/api`.

In the three `tests/api_*_test.yaml` files and `tests/profile_validation_test.yaml`:
- `templates/web-deployment.yaml` / `templates/web-service.yaml` / `templates/web-ingress.yaml` → the `api-` names
- `set:` keys `web.` → `api.` (for example `web.replicas` → `api.replicas`, `web.ingress.enabled` → `api.ingress.enabled`)
- expected names ending `-web` → `-api`; expected component `web` → `api`; expected container name `web` → `api`; expected image `ghcr.io/rophy/opencode-rc/web:` → `ghcr.io/rophy/opencode-rc/api:`

Then run `git grep -n "web" charts/opencode-rc` and fix every remaining hit that refers to the API server (test descriptions such as `it: web ...` included). No hits should remain.

- [ ] **Step 3: Run chart tests**

Run: `helm unittest charts/opencode-rc`
Expected: all pass. If a snapshot in `tests/__snapshot__` differs only by the rename, update with `helm unittest -u charts/opencode-rc` and check the snapshot diff contains only `web`→`api` changes.

Run: `helm lint charts/opencode-rc`
Expected: no errors.

- [ ] **Step 4: Skaffold values**

In `e2e/skaffold.yaml`: `web.image.pullPolicy: Never` → `api.image.pullPolicy: Never`, and the three `setValueTemplates` keys `web.image.registry` / `web.image.repository` / `web.image.tag` → `api.image.*`. Also update any `web.` keys in the `dev` profile patches if present.

- [ ] **Step 5: e2e runtime names**

`e2e/e2e.test.ts`: rename the constant `WEB_URL` to `API_URL` everywhere in the file, and change its definition to

```ts
const API_URL = process.env.API_URL ?? "http://opencode-rc-api:8080";
```

Also change `waitFor("web", ...)` labels to `waitFor("api", ...)`.

`e2e/playwright.config.ts`: change the baseURL line to

```ts
    baseURL: process.env.API_URL || "http://opencode-rc-api:8080",
```

`e2e/tls-ca.test.ts`: `get deploy opencode-rc-web` → `get deploy opencode-rc-api` (and any other `opencode-rc-web` reference in the file).

`Makefile` (`up` and `e2e-test` targets): `deployment/opencode-rc-web` → `deployment/opencode-rc-api` (all occurrences), and in both kubectl exec test lines `WEB_URL=http://opencode-rc-web:8080` → `API_URL=http://opencode-rc-api:8080`.

`.github/workflows/e2e.yml`: step name `Wait for web` → `Wait for api`; `deployment/opencode-rc-web` → `deployment/opencode-rc-api` (all); `http://opencode-rc-web:8080` → `http://opencode-rc-api:8080` (all); `WEB_URL=` → `API_URL=` (both test lines).

- [ ] **Step 6: Leftover check**

Run: `git grep -nE "opencode-rc-web|\.Values\.web|WEB_URL|opencode-rc/web|web\.image\.|component: web" -- ':!docs/superpowers' ':!vendor'`
Expected: matches only in README.md, CONTRIBUTING.md (Task 3), nothing else.

- [ ] **Step 7: Full e2e**

Run: `./e2e/run.sh`
Expected: exit 0; vitest 44/44, Playwright 14/14; "Gateway coverage collected"; the `opencode-rc-e2e` cluster is deleted at the end.

- [ ] **Step 8: Commit**

```bash
git add -A charts e2e Makefile .github/workflows/e2e.yml
git commit -m "refactor: rename web chart values and resources to api"
```

---

### Task 3: Docs

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `DESIGN.md`, `.claude/skills/check-versions.md`

**Interfaces:**
- Consumes: all names from Tasks 1-2.

- [ ] **Step 1: Update references**

- `AGENTS.md` and `CONTRIBUTING.md` project-structure blocks: `web/            # TypeScript (Hono + Bun) — web server: ...` → `api/            # TypeScript (Hono + Bun) — API server: OIDC auth, tokens, SPA serving, proxy to gateway`. Package-manager lists `web/` → `api/`. Build sections `### Web Server` → `### API Server`, `cd web && ...` → `cd api && ...`. Unit-test section `### Web Server Unit Tests` → `### API Server Unit Tests`, `cd web && bun run test` → `cd api && bun run test`. `The Helm chart (web, gateway, redis, oidc-mock)` → `(api, gateway, redis, oidc-mock)`. `## Web Environment Variables` → `## API Environment Variables`. Version table rows `Web | web/package.json` → `API | api/package.json`, `web.image.tag` → `api.image.tag`, and the bump rule `bump web/package.json ... update web.image.tag` → `api/package.json ... api.image.tag`. "must match web" (TOKEN_SECRET row) → "must match api".
- `README.md`: component table row `| Web Server | \`web/\` (TypeScript) | ...` → `| API Server | \`api/\` (TypeScript) | ...`; mermaid node label `WEB["Web Server"]` → `WEB["API Server"]` (keep the node id); values table `web.ingress.enabled` (and any other `web.*` rows) → `api.*` with "Create Ingress for API server"; image table `ghcr.io/rophy/opencode-rc/web` → `ghcr.io/rophy/opencode-rc/api` with the current version `0.6.0`; "Redirect URI: `https://<web-host>/auth/callback`" → `https://<api-host>/auth/callback`.
- `DESIGN.md`: heading `### Web Server (\`web/\` — TypeScript, Hono + Bun)` → `### API Server (\`api/\` — TypeScript, Hono + Bun)`; "Web server (Bun) and gateway (Go) are separate containers" → "API server (Bun) and gateway (Go) ..."; other "web server" mentions meaning the API server → "API server". Keep "web UI" / "web interface" where it means the browser UI.
- `.claude/skills/check-versions.md`: row `| **Web** | \`web/package.json\` | ghcr.io docker image | \`.github/workflows/web.yml\` | \`web/**\`, \`ui/**\`, \`vendor/opencode\` |` → `| **API** | \`api/package.json\` | ghcr.io docker image | \`.github/workflows/api.yml\` | \`api/**\`, \`ui/**\`, \`vendor/opencode\` |`; commands `cat web/package.json` → `cat api/package.json`, `opencode-rc/web:<version>` → `opencode-rc/api:<version>`; notes "Web bundles UI — the web docker image" → "API bundles UI — the api docker image", "Changes to `ui/src/` require a web version bump even though `web/` itself didn't change" → "... an api version bump even though `api/` itself didn't change"; `web.image.tag` → `api.image.tag`; "web bump → chart bump" → "api bump → chart bump".

- [ ] **Step 2: Leftover check**

Run: `git grep -nE "\bweb/|opencode-rc-web|opencode-rc/web|web\.image|web\.ingress|WEB_URL|workflows/web\.yml" -- ':!docs/superpowers' ':!vendor' ':!ui/bun.lock'`
Expected: no matches.

Run: `make unit-test`
Expected: pass (docs-only change; sanity check).

- [ ] **Step 3: Commit**

```bash
git add README.md CONTRIBUTING.md AGENTS.md DESIGN.md .claude/skills/check-versions.md
git commit -m "docs: rename web server to api server"
```
