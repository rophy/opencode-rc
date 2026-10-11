# opencode 2.0 Support, Step 6: Mobile Routing and End-to-End Tests with a Real 2.x Machine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mobile apps can open 2.x sessions, and the e2e suite runs a second dev machine with
opencode 2.0.26 next to the 1.x one, covering registration, the proxy, the 2.x API guards,
uploads, the terminal, the 2.x UI in a browser, and switching between builds.

**Architecture:**
- **Mobile:** Capacitor's local server answers any path without a file extension with the root
  `index.html` (the 1.x build). The shared shell therefore bounces: when the 1.x build starts on
  a `/v2/...` path, it navigates to `/v2/index.html?rc_path=<original path>` (a real file, so
  Capacitor serves the 2.x build); the 2.x build, started at `/v2/index.html` with `rc_path`,
  restores the original path with `history.replaceState` before rendering. On the web, nginx
  already serves `/v2/index.html` for `/v2/*`, so the bounce never triggers there.
- **e2e:** the dev-machine image gets a build arg selecting the opencode major; a second
  Deployment `dev-machine-v2` (session `alice-dev-v2`, same user) runs the CLI against
  opencode 2.0.26. Tests keep running in the 1.x dev-machine pod.

**Tech Stack:** SolidJS (UI), vitest + Playwright (e2e), Skaffold, kind, Docker.

**Spec:** `docs/superpowers/specs/2026-10-11-opencode-v2-support-design.md` ("Mobile", "Testing", "Risks").

## Global Constraints

- Work in the worktree `.claude/worktrees/staging+v2` on branch `staging/v2`. Never push; never merge.
- 1.x behaviour and the existing e2e tests' intent must not change (adapt them only where they assumed a single dev machine).
- Bounce rule (verbatim): only when `BASE === ""` and `location.pathname` starts with `/v2/`; target `/v2/index.html?rc_path=<encodeURIComponent(pathname + search + hash)>`. The 2.x build restores only an `rc_path` that starts with `/v2/` (same-origin path; anything else is ignored).
- The 2.x dev machine runs opencode **2.0.26** exactly (it must be inside `config/opencode-versions.json`'s range) and the repo's CLI.
- No kubectl in implementer tasks except via the existing e2e scripts if a task says to run them; the controller runs the full e2e suite.
- Real opencode runs outside containers must use isolated `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`.
- Package managers: bun in `ui/`; npm in `cli/`, `e2e/`. UI tests on Node 22: `npx -y node@22 node_modules/vitest/vitest.mjs run`.
- Commit messages: `<type>: <short description>`; no attribution lines, no mention of Claude. GPG signing is automatic; never disable it.
- No version bumps. Committed text must not name `.local/`, `LOCAL.md`, private hostnames or IPs.

---

### Task 1: Mobile routing bounce

**Files:**
- Create: `ui/src/build-route.ts` (pure functions), `ui/src/build-route.test.ts`
- Modify: `ui/src/entry.tsx` (call them before rendering)

**Interfaces:**
- Produces: `bounceTarget(base: string, loc: { pathname: string; search: string; hash: string }): string | null`
  (1.x on `/v2/...` → `/v2/index.html?rc_path=...`, else null) and
  `restoredPath(base: string, loc: { pathname: string; search: string }): string | null`
  (2.x at `/v2/index.html` with an `rc_path` starting with `/v2/` → that path, else null).

- [ ] **Step 1: Tests**: `bounceTarget("", {pathname: "/v2/s/a/", search: "?x=1", hash: "#h"})` →
  `/v2/index.html?rc_path=%2Fv2%2Fs%2Fa%2F%3Fx%3D1%23h`; `bounceTarget("", {pathname: "/s/a/"...})` → null;
  `bounceTarget("/v2", ...)` → null always; `bounceTarget("", {pathname: "/v2"...})` → null (only `/v2/`
  prefix). `restoredPath("/v2", {pathname: "/v2/index.html", search: "?rc_path=%2Fv2%2Fs%2Fa%2F%3Fx%3D1%23h"})` →
  `/v2/s/a/?x=1#h`; `rc_path` not starting with `/v2/` (e.g. `//evil.example/x`, `https://evil/x`, `/s/a/`) → null;
  base `""` → null; other pathnames → null.
- [ ] **Step 2: Implement** and wire into `entry.tsx` at the very top of the boot path (before
  `completeLogin()`/render): if `bounceTarget(...)` → `location.replace(target)` and stop; else if
  `restoredPath(...)` → `history.replaceState(history.state, "", path)`. Comment why (Capacitor's
  root `index.html` fallback; harmless on the web).
- [ ] **Step 3:** UI typecheck (both projects), Node 22 tests, `bun run build`. If an Android
  emulator or iOS simulator is available locally, optional manual check: build, `npx cap sync`,
  open a `/v2/s/x/` link from the picker; otherwise say not run.
  Commit — `fix(ui): open 2.x sessions in the mobile apps`

---

### Task 2: e2e infrastructure for a second dev machine on opencode 2.0.26

**Files:**
- Modify: `cli/Dockerfile` (build arg `OPENCODE_MAJOR`, default 1), `e2e/skaffold.yaml` (artifact `dev-machine-v2` with `buildArgs: {OPENCODE_MAJOR: "2"}`), `e2e/k8s/dev-machine.yaml` (second Deployment), `e2e/helpers.ts` (`SESSION_ID_V2`), `e2e/rc-config.json` and `e2e/values.yaml` (2.x toggles), any e2e test that assumed one session
- Possibly: `Makefile` / `e2e/run.sh` if they wait for the dev machine

**Interfaces:**
- Produces: a dev machine registering session `alice-dev-v2` (user `user1`) with
  `opencodeVersion` `2.0.26`; `SESSION_ID_V2` exported from `e2e/helpers.ts` (env
  `OPENCODE_RC_SESSION_ID_V2`, default `alice-dev-v2`).

- [ ] **Step 1: Image**: in `cli/Dockerfile`, `ARG OPENCODE_MAJOR=1`. For `1`, keep today's pinned,
  checksum-verified 1.18.29 tarball. For `2`, install opencode 2.0.26 with
  `npm install -g @opencode/cli@2.0.26` (exact version; npm verifies the registry integrity) and
  check `opencode --version` prints `opencode v2.0.26` (fail the build otherwise). Pin the version
  in an `ARG OPENCODE_V2_VERSION=2.0.26` next to the 1.x pins with the same "bump together" comment
  (keep it inside `config/opencode-versions.json`).
- [ ] **Step 2: Deployment**: in `e2e/k8s/dev-machine.yaml` add `dev-machine-v2` (same
  ServiceAccount and config map, image `dev-machine-v2`, env `OPENCODE_RC_SESSION_ID=alice-dev-v2`,
  same `OPENCODE_RC_GATEWAY_URL`, OIDC env, `OPENAI_API_KEY`). It runs only the CLI; tests stay in
  `dev-machine`. Mount the same `opencode.json` (2.x migrates the 1.x `provider` format,
  `packages/core/src/config/normalize.ts`). Skaffold: add the artifact and make sure the manifest's
  `image: dev-machine-v2` is replaced.
- [ ] **Step 3: Wait for both**: wherever e2e waits for the dev machine's session (helpers or
  setup), also wait for `alice-dev-v2`; fail with a clear message if it never registers (print
  `kubectl logs deploy/dev-machine-v2` in `run.sh`/Makefile on failure if there is a natural
  place).
- [ ] **Step 4: 2.x toggles in the e2e config** (mirror the 1.x ones): `e2e/rc-config.json` (UI
  build) gets `"opencodeV2": {"features": {"uploads": {"enabled": false}, "terminal": {"enabled": false}}}`;
  `e2e/values.yaml` `config:` (API) gets `opencodeV2.features.uploads.enabled: false` (terminal
  stays enabled in the API, as for 1.x, so the terminal-enabled tests can run).
- [ ] **Step 5: Adapt single-session assumptions**: find tests that pick "the" session (e.g. the
  first picker card, `sessions[0]`, a count of 1) and make them select `SESSION_ID` explicitly.
  Don't weaken assertions.
- [ ] **Step 6:** `cd e2e && npx tsc --noEmit -p tsconfig.json`; build both dev-machine images
  locally (`docker build -f cli/Dockerfile --build-arg OPENCODE_MAJOR=2 -t dev-machine-v2:test .`)
  and run `docker run --rm --entrypoint opencode dev-machine-v2:test --version`. Do not run the e2e
  suite (the controller does). Commit — `test(e2e): run a second dev machine on opencode 2.x`

---

### Task 3: e2e API tests against the 2.x machine

**Files:**
- Create: `e2e/v2.test.ts`
- Modify: `e2e/feature-toggles.test.ts` (a 2.x terminal-disabled case using its redeploy helper), `cli/Dockerfile` (COPY picks up the new test file automatically if it uses `e2e/*.test.ts`; check)

**Interfaces:**
- Consumes: `SESSION_ID_V2`, `loginAs`, `waitFor`, `API_URL` (helpers), the redeploy helper in `feature-toggles.test.ts`.

Write tests (vitest, run inside the 1.x dev-machine pod like the others) that, as `user1`:
- [ ] `GET /gateway/sessions` lists `alice-dev-v2` with `opencodeVersion: "2.0.26"` and `SESSION_ID` with a 1.x version.
- [ ] `GET /proxy/alice-dev-v2/api/info` → 200 JSON with `version: "2.0.26"` (the CLI's Basic auth works end to end).
- [ ] `GET /proxy/alice-dev-v2/api/event` returns `text/event-stream` and at least one event within a timeout (SSE through the tunnel).
- [ ] 2.x guards: `POST /proxy/alice-dev-v2/api/shell` → 400 `_tag: FeatureDisabled`; `GET /proxy/alice-dev-v2/session` (1.x legacy path) → 400; `GET /proxy/alice-dev-v2/auth/connect/x` → 400; and on the 1.x session `GET /proxy/<SESSION_ID>/auth/connect/x` → 403.
- [ ] Uploads disabled for 2.x (API config): `POST /proxy/alice-dev-v2/api/experimental/fs/write?path=/tmp/x` → 400; a prompt with a `data:` file in top-level `files` → 400 (create a session first with `POST /api/session` if the route needs a real session id; use the response's id). A text-only prompt is accepted (do not wait for a model reply).
- [ ] Terminal enabled for 2.x: `POST /proxy/alice-dev-v2/api/pty` → 200 with an id; `POST .../api/pty/<id>/connect-token` → ticket; WebSocket `wss/ws ${API_URL}/proxy/alice-dev-v2/api/pty/<id>/connect?ticket=<ticket>&access_token=<token>` echoes a command (follow the 1.x "echoes a command" test). This is the path the step 5 review asked to exercise.
- [ ] In `feature-toggles.test.ts`, add a 2.x case to the existing redeploy flow: with `opencodeV2.features.terminal.enabled: false` in the API config, `POST /proxy/alice-dev-v2/api/pty` → 400 `FeatureDisabled`; restore afterwards (reuse the helper; keep the file's one-file-at-a-time assumption).
- [ ] `npx tsc --noEmit -p tsconfig.json` in e2e. Commit — `test(e2e): API and tunnel tests against an opencode 2.x machine`

---

### Task 4: Browser tests for the 2.x UI, and the shared-database note

**Files:**
- Create: `e2e/playwright/v2.spec.ts`
- Modify: `README.md` (shared opencode database note)

**Interfaces:**
- Consumes: Playwright helpers in `e2e/playwright/` (login as alice/user1 etc.), `SESSION_ID_V2`.

- [ ] **Tests** (follow `web-ui.spec.ts` / `golden-path.spec.ts` patterns):
  - The picker shows both machines; the 2.x card shows "opencode 2.0.26" and links to `/v2/s/alice-dev-v2/`.
  - Clicking it loads the 2.x UI: the URL is under `/v2/s/alice-dev-v2/`, our user bar is shown, and an element of opencode 2.x's UI renders (find a stable selector in vendor/opencode-v2's app — e.g. the composer; document which), with no uncaught page errors.
  - Opening `/s/alice-dev-v2/` (wrong build) redirects to `/v2/s/alice-dev-v2/`; opening `/v2/s/<SESSION_ID>/` redirects to `/s/<SESSION_ID>/`.
  - Terminal disabled in the 2.x UI build: ctrl+` opens no terminal panel (mirror the 1.x test).
  - Uploads disabled in the 2.x UI build: the composer's "+" menu has no attach item (mirror the 1.x test).
  - Switching builds in one browser context: open the 1.x session, then the 2.x session, then the 1.x session again; each loads its UI with no uncaught page errors (both opencode apps share localStorage keys).
  - Golden path on 2.x (follow `golden-path.spec.ts`): send a message, see the mock AI's reply. If 2.x can't talk to the mock AI with the shared `opencode.json`, find out why (2.x config format) and fix the config for the 2.x machine; if it's not fixable in this step, mark the test `test.fixme` with the reason and report it.
- [ ] **README**: in the opencode 2.x section, note that opencode 1.x and 2.x on the same machine share opencode's data directory and database, that 2.x migrates the database in place the first time it runs, and that switching a machine back to 1.x afterwards is not something opencode guarantees. One short paragraph.
- [ ] `npx tsc --noEmit -p tsconfig.json` in e2e. Commit — `test(e2e): browser tests for the 2.x UI` (and `docs: …` for the README if separate).

---

## After the tasks (controller)

- Run the full e2e suite on kind (`KUBE_CONTEXT=kind-gen1 NAMESPACE=opencode-rc-e2e-v2 ./e2e/run.sh`); fix failures through the fix loop.
- Final whole-branch review of step 6; then the whole opencode 2.0 effort is complete apart from the release (version bumps), which the user decides.
