# opencode 2.0 Support, Step 4: The 2.x UI Build, Routing and the First 2.x Range

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ui/` builds twice: the 1.x build at `/` (unchanged) and a 2.x build at `/v2/` from
`vendor/opencode-v2`, with its own feature patches and an upload shim. The picker sends each
machine to the matching build, and each build redirects a session that belongs to the other.
The gateway accepts opencode 2.0.26 (the first 2.x range), which deployments can narrow.

**Architecture:** One Vite config parameterized by `OPENCODE_MAJOR` (unset = 1, `2` = 2.x):
opencode root, package scope (`@opencode-ai/` vs `@opencode/`), patches (`vendor/patches/v1|v2`),
feature list and toggles, `base` (`/` vs `/v2/`) and `outDir` (`dist` vs `dist/v2`). The shared
shell (login, picker, config, user bar) stays in `src/entry.tsx`; the opencode-specific session
view moves to `src/session-view-v1.tsx` / `src/session-view-v2.tsx`, selected by a `#session-view`
alias. `bun run build` runs both builds (1.x first, since it empties `dist/`).

**Tech Stack:** Vite 8, SolidJS, vitest 5 (jsdom), nginx, Go (gateway), Helm (chart unittest).

**Spec:** `docs/superpowers/specs/2026-10-11-opencode-v2-support-design.md` ("UI", "Deployment
config", "Version policy within 2.x", "Repository layout").

**Decisions already made (user):** 1.x at `/`, 2.x at `/v2/`. 2.x toggles independent, default on.
Office preview stays in the 2.x build (future work). Range is `min ≤ v < max`, default per build,
deployments may only narrow it, enforced by the gateway; the UI checks only the major version.

**Controller decisions for this step:**
- The 2.x range in `config/opencode-versions.json` becomes `2.0.26` up to (not including) `2.0.27`:
  exactly the pinned submodule. A test keeps the pin and the range consistent.
- 2.x file names containing `# % ? ;` stay unreachable remotely (step 3's path rule). Supporting
  them needs the gateway and CLI to forward the escaped path untouched; out of scope, documented.
- The Android language list keeps coming from the 1.x submodule (mobile is step 6).
- No e2e against a 2.x machine yet (the CLI can launch 2.x only from step 5); step 4 is verified by
  unit tests, both builds, the image smoke test, a browser check of `/v2/` and the 1.x e2e suite.

## Global Constraints

- Work in the worktree `.claude/worktrees/staging+v2` on branch `staging/v2`. Never push; never merge.
- The 1.x build's output and behaviour must not change (same `dist/` root files, same routes).
- `OPENCODE_MAJOR` unset or `1` → 1.x build; `2` → 2.x build. Any other value fails the build.
- 2.x build: `base: "/v2/"`, output `dist/v2/`, root `vendor/opencode-v2`, packages `@opencode/*`, patches `vendor/patches/v2/<feature>/` for `FEATURES_V2`, toggles `rcConfig.opencodeV2.features`.
- Session routing: missing or `1.*` `opencodeVersion` → `/s/<id>/`; anything else → `/v2/s/<id>/` (same rule as the API's `isV1Session`).
- `vendor/opencode-v2` dependencies are installed with `bun install --frozen-lockfile --ignore-scripts` (its `prepare` script runs husky, which rewrites the shared git hooks path).
- Package managers: bun in `ui/`, `api/`, both submodules; npm in `cli/`, `e2e/`. Tests on Node 22: `npx -y node@22 node_modules/vitest/vitest.mjs run`.
- Commit messages: `<type>: <short description>`; no attribution lines, no mention of Claude. GPG signing is automatic; never disable it.
- No version bumps. Committed text must not name `.local/`, `LOCAL.md`, private hostnames or IPs.

---

### Task 1: Split the session view out of `entry.tsx` (1.x only, no behaviour change)

**Files:**
- Create: `ui/src/session-view-v1.tsx`, `ui/src/session-router.ts`, `ui/src/build-info.ts`
- Modify: `ui/src/entry.tsx`, `ui/vite.config.ts` (alias `#session-view`), `ui/tsconfig.json` (path `#session-view`), `ui/vitest.config.ts` (same alias if any test imports entry)

**Interfaces:**
- Produces: `SessionView(props: { sessionId: string; user: Me; onSettings: () => void; onForbidden: () => void }): JSX.Element` exported from `#session-view` (each version file); `createSessionRouter(sessionPrefix: string)` in `session-router.ts` (the current inline `createRouter({...})` block, unchanged apart from taking the prefix); `BASE` in `build-info.ts` = `import.meta.env.BASE_URL` without the trailing slash (`""` for 1.x, `"/v2"` for 2.x). The opencode app CSS import moves into the session-view file (the shell's classes come from it, so the shell imports the session view statically).

- [ ] **Step 1:** Move, without changing logic: the `platform` object, `AutoOpenProjects`, the
  proxy installation (`installProxyFetch`/`installProxyWebSocket`), the `ServerConnection` setup
  and the JSX returned in the `user() && sessionId` match into `SessionView` in
  `session-view-v1.tsx` (with `import "@opencode-ai/app/index.css"` and the `@opencode-ai/app`
  imports). Move the router block into `createSessionRouter(sessionPrefix)` in
  `session-router.ts`. `entry.tsx` keeps the polyfills, the `App` shell and the render call, and
  renders `<SessionView sessionId=… user=… onSettings=… onForbidden={recheckAccess} />`.
- [ ] **Step 2:** `getSessionIdFromPath()` uses `BASE`: match `^${BASE}/s/([^/]+)` (escape for the
  regex; `BASE` is `""` or `"/v2"`), and the session prefix becomes `${BASE}/s/${id}`.
- [ ] **Step 3:** Alias: `resolve.alias["#session-view"] = path.join(import.meta.dirname, "src/session-view-v1.tsx")`
  in `vite.config.ts`; `"#session-view": ["./src/session-view-v1.tsx"]` in `tsconfig.json` paths.
- [ ] **Step 4: Verify no behaviour change**

```bash
cd ui && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
env -u OPENCODE_RC_CONFIG bun run build && ls dist | sort > /tmp/step4-t1-files.txt
OPENCODE_RC_CONFIG=$PWD/../e2e/rc-config.json bun run build
```

Expected: typecheck 0 errors in ui; tests as before (211 passed, none skipped); both builds pass.

- [ ] **Step 5: Commit** — `refactor(ui): move the opencode session view out of the shell`

---

### Task 2: The 2.x build

**Files:**
- Create: `ui/src/session-view-v2.tsx`, `ui/tsconfig.v2.json`
- Modify: `ui/vite.config.ts`, `ui/package.json` (scripts), `ui/build/typecheck.ts`, `ui/web/Dockerfile`, `ui/web/nginx.conf`, `ui/web/smoke-test.sh`, `.github/workflows/ui.yml`, `.github/workflows/ios.yml`, `.github/workflows/android.yml`, `.github/workflows/e2e.yml` (only if it installs vendor deps), `.dockerignore` (if needed)

**Interfaces:**
- Consumes: Task 1's `SessionView` contract, `createSessionRouter`, `BASE`.
- Produces: `dist/v2/index.html` and assets under `dist/v2/`, served at `/v2/`.

- [ ] **Step 1: Vite config parameterized by `OPENCODE_MAJOR`**

At the top of `ui/vite.config.ts`:

```ts
// Which opencode the build wraps: unset or "1" builds the 1.x UI at /, "2" the 2.x UI at /v2/.
const major = process.env.OPENCODE_MAJOR ?? "1"
if (major !== "1" && major !== "2") throw new Error(`OPENCODE_MAJOR must be 1 or 2, got ${major}`)
const v2 = major === "2"
const opencodeRoot = v2
  ? process.env.OPENCODE_V2_ROOT || path.resolve(import.meta.dirname, "../vendor/opencode-v2")
  : process.env.OPENCODE_ROOT || path.resolve(import.meta.dirname, "../vendor/opencode-v1")
const scope = v2 ? "@opencode/" : "@opencode-ai/"
```

Use `scope` wherever the config tests `"@opencode-ai/"` (package scan and resolver). Patches:
`featurePatches(path.resolve(import.meta.dirname, v2 ? "../vendor/patches/v2" : "../vendor/patches/v1"), v2 ? FEATURES_V2 : FEATURES, <disabled names from rcConfig.opencodeV2.features or rcConfig.features>)`.
`base: v2 ? "/v2/" : "/"`, `build.outDir: v2 ? "dist/v2" : "dist"`, `build.emptyOutDir: !v2`
(the 2.x build must not delete the 1.x output). Alias `#session-view` to the version's file. For
v2 add the alias `"@betteroffice/fonts-cjk"` → `path.join(opencodePackages, "gui-extensions/src/microsoft-office/fonts-cjk.ts")`
(mirrors upstream `packages/app/vite.js`). `opencodeAppFonts` keeps working (it rewrites
`/assets/` URLs in the root's `packages/app/src/index.css`; v2's CSS uses the same form).
`server.fs.allow` includes `opencodeRoot`.

`ui/package.json` scripts: `"build": "vite build && OPENCODE_MAJOR=2 vite build"`, add
`"build:v1": "vite build"`, `"build:v2": "OPENCODE_MAJOR=2 vite build"`, `"dev:v2": "OPENCODE_MAJOR=2 vite"`.

- [ ] **Step 2: `session-view-v2.tsx`**

Same contract as v1. Differences (from the spike, verified to build and render the login screen):

```tsx
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, type Platform } from "@opencode/app"
import { useGlobal } from "@opencode/app/desktop"
import "@opencode/app/index.css"

// 2.x: projects are per-server state in the global runtime; AppInterface children render
// inside GlobalProvider.
function AutoOpenProjects(props: { server: ServerConnection.Any }) {
  const global = useGlobal()
  createEffect(() => {
    const ctx = global.ensureServerCtx(props.server)
    for (const project of ctx.sync.data.project) ctx.projects.open(project.worktree)
  })
  return null
}
// ...
<AppInterface canonicalLocalServer={serverKey} servers={[server]} router={SessionRouter}>
  <AutoOpenProjects server={server} />
</AppInterface>
```

(No `defaultServer`, `disableHealthCheck` or `serverScoped`: removed in 2.x.) Install the same
fetch/WebSocket proxies as v1; Task 3 adds the XHR shim.

- [ ] **Step 3: Type-check both**

`ui/tsconfig.v2.json` extends `tsconfig.json` and overrides `paths`:
`"@opencode/app": ["../vendor/opencode-v2/packages/app/src/index.ts"]`,
`"@opencode/app/desktop": ["../vendor/opencode-v2/packages/app/src/desktop.ts"]`,
`"@/*": ["../vendor/opencode-v2/packages/app/src/*"]`, `"#session-view": ["./src/session-view-v2.tsx"]`,
and `exclude: ["src/session-view-v1.tsx"]`; `tsconfig.json` excludes `src/session-view-v2.tsx`.
(Check that the export paths exist in v2.0.26; adjust to the real files.) `ui/build/typecheck.ts`
runs tsc for both projects and reports `<n> error(s) in ui` per project; any ui error fails.

- [ ] **Step 4: Image, nginx and CI**

- `ui/web/Dockerfile`: copy and install `vendor/opencode-v2` like v1 but with
  `bun install --frozen-lockfile --ignore-scripts`; build with `bun run build` (no `OPENCODE_ROOT`
  override needed; remove it).
- `ui/web/nginx.conf`: add, before `location /`:

```nginx
    location /v2/assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        include /etc/nginx/rc/security-headers.conf;
        try_files $uri =404;
    }
    location /v2/ {
        add_header Cache-Control "no-cache" always;
        include /etc/nginx/rc/security-headers.conf;
        try_files $uri /v2/index.html;
    }
```

- `ui/web/smoke-test.sh`: also check `/v2/` and `/v2/s/x/` return the 2.x `index.html` (it
  references `/v2/assets/`), a `/v2/assets/*.js` asset gets the immutable cache header, and
  `/v2/assets/nope.js` is 404.
- CI (`ui.yml` test job, `ios.yml`, `android.yml`, and any job that builds the UI outside Docker):
  `cd vendor/opencode-v2 && bun install --frozen-lockfile --ignore-scripts` next to the v1 install;
  add `'vendor/opencode-v2'` to the path filters that list `'vendor/opencode-v1'`.

- [ ] **Step 5: Verify**

```bash
cd vendor/opencode-v2 && bun install --frozen-lockfile --ignore-scripts && cd ../../ui
bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
env -u OPENCODE_RC_CONFIG bun run build && ls dist/v2/index.html && grep -c '/v2/assets/' dist/v2/index.html
diff <(ls dist | grep -v '^v2$' | sort) /tmp/step4-t1-files.txt   # 1.x root unchanged (asset hashes may differ; compare names of top-level entries)
cd .. && docker build -f ui/web/Dockerfile -t opencode-rc-ui:step4 . && ui/web/smoke-test.sh opencode-rc-ui:step4
git -C vendor/opencode-v2 status --short | head   # must be empty
git config --get core.hooksPath; git -C vendor/opencode-v2 config --get core.hooksPath   # report values
```

Then open `http://127.0.0.1:<port>/v2/` from `vite preview` (or the image) in a browser
(Playwright if available) and confirm the login screen renders with no console errors other than
a favicon 404. Report what you saw.

- [ ] **Step 6: Commit** — `feat(ui): build the 2.x UI at /v2/`

---

### Task 3: Upload shim for 2.x (`XMLHttpRequest`)

**Files:**
- Modify: `ui/src/proxy-fetch.ts` (add `installProxyXHR`), `ui/src/session-view-v2.tsx` (install it)
- Test: `ui/src/proxy-fetch.test.ts` (or a new `proxy-xhr.test.ts`)

**Interfaces:**
- Produces: `installProxyXHR(opts: ProxyOptions & { getToken: () => Promise<string | null>; onForbidden?: () => void }): void`.

opencode 2.x uploads attachments with `XMLHttpRequest` to the root-relative
`/api/experimental/fs/write?...` (`packages/app/src/composer/attachments/destination.ts`), which
bypasses the fetch patch and drops the `/proxy/<id>/` prefix.

- [ ] **Step 1: Failing tests** (jsdom): after `installProxyXHR({ pageOrigin: "https://ui.example", serverOrigin: "https://rc.example", sessionId: "abc", getToken: async () => "tok" })`,
  an XHR opened with `"POST", new URL("/api/experimental/fs/write?path=%2Ftmp%2Fu%2Ff", "https://ui.example/proxy/abc/")`
  is sent to `https://rc.example/proxy/abc/api/experimental/fs/write?path=%2Ftmp%2Fu%2Ff` with
  `authorization: Bearer tok`; a cross-origin URL is left untouched and gets no token; an XHR
  aborted before the token resolves is not sent; a 403 response calls `onForbidden`. Restore the
  original prototype methods after each test.
- [ ] **Step 2: Implement** `installProxyXHR` as in the spike (patch `XMLHttpRequest.prototype.open`
  to rewrite the URL with the existing `proxyTarget()`, remember proxied instances in a `WeakSet`,
  and defer `send` until `getToken()` resolves, then set the header; skip if
  `readyState !== OPENED`; on token error send without it). Comment why (the 2.x upload path).
  No 401 retry (the toast "Upload failed" is opencode's; `getAccessToken` already refreshes an
  expired token before it resolves).
- [ ] **Step 3:** Install it in `session-view-v2.tsx` next to `installProxyFetch`, with
  `getToken: getAccessToken, onForbidden`.
- [ ] **Step 4:** typecheck, Node 22 tests, `bun run build`. Commit — `feat(ui): route 2.x attachment uploads through the proxy`

---

### Task 4: 2.x feature patches

**Files:**
- Create: `vendor/patches/v2/uploads/composer.patch`, `vendor/patches/v2/uploads/project-icon.patch`, `vendor/patches/v2/shell/composer.patch`, `vendor/patches/v2/export/command.patch`, `vendor/patches/v2/export/menus.patch`, `vendor/patches/v2/terminal/builtins.patch`
- Create: `ui/build/v2-patches.test.ts`
- Modify: `ui/build/vendor-patches.test.ts` (real v2 root check)

**Interfaces:**
- Consumes: Task 2's build (patches applied for `rcConfig.opencodeV2.features`).

The controller provides starting patches written against v2.0.26 during research (not
committed; the dispatch names their location). Copy them into `vendor/patches/v2/<feature>/` and
verify each one:

- [ ] **Step 1:** For every patch: `cd vendor/opencode-v2 && git apply --check ../patches/v2/<feature>/<file>.patch`
  (paths relative to the submodule root, plain `git diff` format, edits of existing files only —
  the format `ui/build/vendor-patches.ts` accepts). Fix any that don't apply. Then confirm what
  each removes (from the research):
  - uploads/composer: the `attachments:` config in `createComposerController` (`packages/app/src/composer/model.ts`), the `file.attach` command, and the "+" menu attach item (`composer/editor/editor.tsx`); uploads/project-icon: `selectFile` returns early and nothing clicks the icon input (`settings/workspaces/project-model.ts`).
  - shell: the reducer's `mode.shell` transition stays `normal` (`composer/suggestions/machine.ts`), the `"!"` trigger is disabled, `prompt.mode.shell` is `disabled: true, hidden: true`, the "+" menu shell item is removed.
  - export: the `session.export` command (`session/commands/use-session-commands.tsx`), the timeline title menu item, the home session row item, and the context-tab "Export session" button (`gui-extensions/src/context/tab.tsx`).
  - terminal: `terminal` removed from the built-ins (`packages/gui-extensions/src/renderer.ts`).
- [ ] **Step 2: Tests** `ui/build/v2-patches.test.ts`, modeled on `feature-patch-sets.test.ts`
  (root `vendor/opencode-v2`, patches `vendor/patches/v2`, features `FEATURES_V2`; no `skipIf` —
  CI checks out and installs the submodule): every combination of disabled features applies;
  per feature, assert on the patched source like the 1.x tests do (e.g. the patched
  `renderer.ts` no longer lists `terminal` in the built-ins; the patched commands file has no
  `session.export`; the composer model has no `file.attach`). In `vendor-patches.test.ts`, add
  "matches the features in the real vendor/patches/v2" asserting the directory list is exactly
  `["export", "shell", "terminal", "uploads"]` and `featurePatches(..., FEATURES_V2, [])` does not throw.
- [ ] **Step 3: Builds** with each 2.x feature disabled alone and all together, e.g.
  `echo '{"opencodeV2":{"features":{"terminal":{"enabled":false}}}}' > /tmp/v2-term.json && OPENCODE_RC_CONFIG=/tmp/v2-term.json bun run build:v2`;
  for terminal-off also check that `dist/v2/assets` has no ghostty chunk (`ls dist/v2/assets | grep -i ghostty` empty).
- [ ] **Step 4:** AGENTS.md "Patches" section: 2.x patches live in `vendor/patches/v2/<feature>/`
  (relative to `vendor/opencode-v2`), with the same apply/edit/write-back commands using
  `cd vendor/opencode-v2` and `../patches/v2/...`. Commit — `feat(ui): feature patches for the 2.x UI`

---

### Task 5: Picker routing and the mismatch redirect

**Files:**
- Create: `ui/src/opencode-version.ts` (`isV1Session`, `sessionPath`)
- Modify: `ui/src/session-picker.tsx`, `ui/src/entry.tsx`
- Test: `ui/src/opencode-version.test.ts`, `ui/src/session-picker.test.tsx`, a test for the redirect (follow the existing `entry`/screen test patterns; if `App` is not testable in isolation, extract the decision into a pure function and test that)

**Interfaces:**
- Produces: `isV1Session(version?: string): boolean` (missing or `/^1\./`), `sessionPath(session: { id: string; opencodeVersion?: string }): string` → `/s/<encoded id>/` or `/v2/s/<encoded id>/` (absolute, origin-relative, independent of the current build's base).

- [ ] **Step 1: Tests**: `isV1Session` cases as in the API; picker links for a 1.x session (`/s/a/`),
  a session without a version (`/s/b/`) and a 2.x session (`/v2/s/c/`), in both builds (the
  link does not depend on `BASE`); existing "links stay relative when a remote server is
  configured" test still passes.
- [ ] **Step 2: Picker**: use `sessionPath(props.session)` for the card `href`.
- [ ] **Step 3: Redirect**: when the shell has a `sessionId` and a signed-in user with access, it
  loads the session list (`fetchSessions`, as the picker does) before rendering `SessionView`. If
  the session is found and belongs to the other build (`isV1Session(version) !== (BASE === "")`),
  `location.replace(sessionPath(session) + <rest of the current path after the session prefix> + location.search + location.hash)`.
  If not found, render `SessionView` as today (the API answers 404 as before). While loading,
  show the existing "Loading..." view. Keep it one request.
- [ ] **Step 4:** typecheck (both projects), Node 22 tests, `bun run build`. Commit — `feat(ui): send each dev machine to the UI build for its opencode version`

---

### Task 6: The first 2.x range and deployment narrowing

**Files:**
- Modify: `config/opencode-versions.json`, `config/schema.ts` (`opencodeV2.versions`), `gateway/versions.go`, `gateway/config.go`, `gateway/main.go`, `charts/opencode-rc/templates/gateway-deployment.yaml`
- Test: `gateway/versions_test.go`, `api/src/rc-config.test.ts` (schema), `charts/opencode-rc/tests/gateway_deployment_test.yaml`, a consistency test (below)

**Interfaces:**
- Consumes: gateway `VersionPolicy`/`LoadVersionPolicy` (step 2), chart's `{{ fullname }}-api-config` ConfigMap (rendered from `.Values.config` when set).
- Produces: `config/opencode-versions.json` = `{ "v2": { "min": "2.0.26", "max": "2.0.27" } }`;
  `RcConfig.opencodeV2.versions?: { min: string; max: string }`; gateway env `OPENCODE_RC_CONFIG`
  (path to the deployment config.json, optional).

- [ ] **Step 1: Schema** (`config/schema.ts`): `opencodeV2` also accepts `versions: { min, max }`,
  both required strings matching `/^\d+\.\d+\.\d+$/`, `min < max` numerically; unknown keys are
  errors; omitted → field absent. Tests in `api/src/rc-config.test.ts`.
- [ ] **Step 2: Range file** `{ "v2": { "min": "2.0.26", "max": "2.0.27" } }`. Consistency test
  (put it in `api/src/` next to the route-table tests, which already read the submodules): the
  version in `vendor/opencode-v2/packages/app/package.json` (or the tag the repo pins; use the
  package.json `version` field of `packages/cli` if `app` has none) is `>= v2.min` and `< v2.max`.
- [ ] **Step 3: Gateway narrowing**: `LoadVersionPolicy` keeps loading the defaults; add
  `NarrowVersionPolicy(p VersionPolicy, deploymentConfigPath string) (VersionPolicy, error)` that
  reads only `opencodeV2.versions` from the deployment config (ignore other keys; the API
  validates the full schema), and returns the overlap: `min = max(default.min, deploy.min)`,
  `max = min(default.max, deploy.max)`; if the default is nil or the overlap is empty → nil (no
  2.x), with a warning log; if the deployment range reaches outside the default → clamp and log a
  warning naming both ranges. Missing env → defaults only; env set but file unreadable or invalid
  JSON → fatal (like other config errors). Tests for overlap, clamping, empty overlap, nil
  default, absent `opencodeV2.versions`, invalid file.
- [ ] **Step 4: Chart**: when `.Values.config` is set, the gateway gets env
  `OPENCODE_RC_CONFIG=/etc/opencode-rc/config.json` and mounts the `-api-config` ConfigMap at
  `/etc/opencode-rc` (read-only), mirroring `api-deployment.yaml`. The baked defaults stay at
  `/usr/share/opencode-rc/opencode-versions.json` (not hidden by this mount). If the API deployment
  has a checksum annotation for the config, add the same to the gateway. Chart unittest cases:
  config set → env + volume present; config unset → neither.
- [ ] **Step 5:** `go vet ./... && go test ./...` in gateway/, api tests/typecheck, `helm unittest charts/opencode-rc`
  (follow how the repo runs chart tests; see `Makefile` or CI), gateway image build. Commit —
  `feat: accept opencode 2.0.26, narrowable per deployment`

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` ("Deployment Config" and wherever supported opencode versions / CLI setup are described), `AGENTS.md` (building both UIs, the long line flagged in step 3), `docs/api-versioning.md` (only if something there is now wrong)

- [ ] **Step 1: README**: supported opencode versions (1.x, and 2.x within the range in
  `config/opencode-versions.json`, currently 2.0.26); that a 2.x machine also needs a newer
  opencode-rc CLI (coming in the next release step — word it as "requires opencode-rc CLI with
  2.x support" without promising a version number); `opencodeV2.features` — the 2.x toggles
  (`uploads`, `terminal`, `shell`, `export`), independent of `features`, **enabled unless set to
  false**, so deployments that disable 1.x features must also disable them for 2.x; on 2.x the
  API blocks some routes always (opencode config writes, pairing, MCP server changes, plugin
  updates, ...) — one sentence plus "see `api/src/v2-routes.ts`"; `opencodeV2.versions`
  (`{ "min": ..., "max": ... }`, min inclusive, max exclusive, can only narrow the supported
  range); known 2.x limitations: files whose names contain `# % ? ;` cannot be opened remotely;
  the 2.x UI includes opencode's Office preview (larger download, notably for the mobile apps).
  Follow the README's existing style; no upgrade guide section.
- [ ] **Step 2: AGENTS.md**: building (`bun run build` builds both; `build:v1`/`build:v2`,
  `dev:v2`; `OPENCODE_ROOT` / `OPENCODE_V2_ROOT`; install v2 deps with `--ignore-scripts` and why);
  wrap the overlong plain-path line.
- [ ] **Step 3:** grep the docs for `vendor/opencode\b`, stale `/v1/` UI paths, or claims that 2.x is
  unsupported; fix. Commit — `docs: opencode 2.x support in the deployment config and builds`

---

## After the tasks (controller)

- e2e on kind (`KUBE_CONTEXT=kind-gen1 NAMESPACE=opencode-rc-e2e-v2 ./e2e/run.sh`): 1.x unchanged.
- Browser check of `/v2/` from the built image (login screen renders).
- Final whole-branch review; report to the user, including APK size impact of `dist/v2`.
