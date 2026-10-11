# opencode 2.0 Support (v1 and v2 in One Release)

Date: 2026-10-11
Status: Draft design. Decisions settled (see "Decisions").

## Problem

opencode 2.0 is a near-total rewrite of opencode, released alongside the 1.x line:

- Packages are renamed `@opencode-ai/*` → `@opencode/*`. The CLI ships as `@opencode/cli`
  (bin `opencode`, same name as 1.x `opencode-ai`, so the two cannot both be installed globally).
  1.x continues as maintenance releases (v1.18.x).
- The HTTP API lives only under `/api/*`. Every 1.x route is gone and there is no version
  negotiation; a 1.x client against a 2.0 server (or the reverse) fails.
- `opencode serve` prints a new start line and always requires a password (Basic
  `opencode:<pw>`). The 1.x SDK's `createOpencodeServer`, which our CLI uses, times out against it.
- `packages/app` was rewritten: 31 of 643 files are unchanged. Every file our UI patches touch
  no longer exists.
- 2.0 adds routes that run commands or write files: `POST /api/experimental/fs/write` (writes the
  raw body to any absolute path; this is how the 2.0 app uploads), `POST /api/shell`, persistent
  PTYs, runtime MCP servers, the project startup script and others. Our guards match 1.x paths only.

Users will run both versions for some time. opencode-rc must keep working for 1.x machines and
support 2.0 machines.

Evidence for everything below: opencode v1.18.29 and v2.0.26 source, a build of our UI against
v2.0.26, and runs of the v2.0.26 binary (`serve`, `pair --remote`).

## Goals

- One opencode-rc branch and one release serving dev machines on opencode 1.x and 2.x, in the
  same deployment.
- Feature toggles enforced on 2.x as on 1.x (removed from the UI and rejected by the API), set
  separately per version.
- No change for users of 1.x machines beyond upgrading opencode-rc.

## Non-goals

- Forking opencode or shipping our own opencode binary.
- Serving opencode 2.0's built-in web app (see "Alternatives considered").
- Running the v2 UI against v1 servers or the reverse.
- Controlling `opencode pair --remote` (see "Risks").

## Alternatives considered

**A. Serve opencode 2.0's own web app** (built into the binary) through our edge, keeping only
OIDC, access control and guards. Rejected:

- It only works at an origin root. The app uses `location.origin` as its server URL and absolute
  paths for assets, `/sw.js` and uploads, so `/proxy/<sid>/` breaks. It needs one subdomain per
  machine: wildcard DNS, wildcard TLS and ingress host rules in every deployment.
- Its CSP allows only its own scripts, so our bearer-token fetch patch cannot run. The edge would
  move to cookie sessions with server-side refresh and Origin/CSRF checks.
- No UI patches: a disabled terminal shows an empty panel, export cannot be enforced at all.
- Mobile apps would still need a bundled UI (Capacitor documents remote `server.url` as not for
  production), so the compiled UI does not go away.

**Separate v1 and v2 branches/releases.** Rejected: gateway, OIDC, access webhook, API proxy,
CLI tunnel and mobile shells are shared, so most fixes would be merged twice.

**Self-hosted OpenTunnel instead of the gateway.** Rejected: it is a blind TLS relay (cannot
enforce OIDC, access or guards), opencode hard-codes `https://opentunnel.xyz`, and it has no
per-user registry for the picker.

## Design

### Overview

| Component | Change |
|---|---|
| CLI | Detect the opencode version; launch v1 or v2 mode; report the version to the gateway |
| Gateway | Store the version in the session record; return it in the session list |
| API | Pick the v1 or v2 guard set from the session's version; new v2 allowlist |
| UI | Two builds: 1.x at `/` (unchanged), 2.x at `/v2/`; the picker routes by version |
| Mobile | Bundle both builds |
| Repo | Two submodules, patches split per version |

### Repository layout

- `vendor/opencode-v1` (pinned v1.18.x) and `vendor/opencode-v2` (pinned v2.0.x) replace
  `vendor/opencode`.
- `vendor/patches/v1/<feature>/` and `vendor/patches/v2/<feature>/`. Each version has its own
  feature list in `config/schema.ts` (v2 has no `share`, and may add features 1.x lacks).
- Two separate Vite builds from the same `ui/src`: the 1.x build writes `dist/` as today, the
  2.x build writes `dist/v2/`. Each contains its own copy of login, picker and config screens
  (one bundle cannot hold both opencode apps: global CSS and the `@/` alias clash). 1.x stays at
  the root so 1.x users, links, nginx and the mobile start page are unchanged.
- Dropping v1 later: delete its submodule, patches, guard set and build.
- One development stream: the work merges to `main` in steps, each leaving 1.x working (CI
  publishes only on version bumps). Order: (1) submodule renamed to `vendor/opencode-v1`, patches moved to `vendor/patches/v1/`, Vite 8;
  (2) CLI reports the version, gateway stores it and checks the range, picker shows it
  (no 2.x range yet, so 2.x is rejected);
  (3) API guard sets per version; (4) v2 UI build and patches, picker routing to `/v2/`, first 2.x range; (5) CLI v2 mode; (6) mobile and
  e2e. The release (version bump) follows step 6.

### CLI

1. Run `opencode --version` and parse `/(\d+)\.(\d+)\.(\d+)/`. Output is `1.18.29` on 1.x and
   `opencode v2.0.26` on 2.x.
2. **v1 mode:** unchanged (`createOpencodeServer`, no password).
3. **v2 mode:**
   - Spawn `opencode serve --stdio --hostname 127.0.0.1` (port unset or 0; confirm the flag
     parser accepts `--port 0`) with a random `OPENCODE_SERVER_PASSWORD`.
   - Read the `{"url": …}` line; stop the server by closing stdin.
   - The tunnel overwrites `Authorization` with `Basic base64("opencode:" + pw)` on every
     forwarded HTTP request and WebSocket upgrade, and strips any `auth_token` query parameter
     (it takes precedence over the header and would cause 401s).
   - Not `opencode service`: that is the user's own singleton (fixed port, `service.json` they
     control, may already have remote access enabled). If it is running, ours would attach to it.
4. Send the version on tunnel registration: `/tunnel?sessionId=…&directory=…&opencodeVersion=2.0.26`.
   A missing version means 1.x. Bump the CLI ↔ gateway protocol in step 5, when the CLI first
   relies on the gateway knowing versions (`docs/api-versioning.md`).
   Until step 5, the CLI checks the version before starting opencode and exits on 2.x with
   "opencode 2.x needs a newer opencode-rc".
5. Install: users install opencode themselves (`opencode-ai` for 1.x or `@opencode/cli` for 2.x),
   then `opencode-rc`, as today. opencode-rc does not depend on or bundle opencode (a v2 binary is
   ~210 MB per platform).
6. The gateway rejects a version outside the supported range at registration (see "Version
   policy"); the CLI prints its message and exits.

### Gateway

- Add `opencodeVersion` to the session record (`gateway/store.go`), read from the tunnel query
  (`gateway/tunnel.go`), and include it in the session list.
- Reject a 2.x version outside the supported range at `/tunnel` (see "Version policy"). The
  default range comes from `config/opencode-versions.json`, copied into the gateway image; the
  deployment's `config.json` (the API's ConfigMap, now also mounted into the gateway) can narrow
  it. The gateway applies the overlap.
- No path-specific logic changes: the gateway forwards `/proxy/<sid>/*` unchanged.

### API

- Proxy, WebSocket relay and SSE handling are version-agnostic (SSE is detected by
  content-type) and stay shared. The API keeps sending its bearer token to the gateway; the
  opencode password never leaves the dev machine.
- **Guards per major version.** The API looks up the session's version from the gateway's
  session record (never from the browser) and applies that version's guard set with that
  version's toggles. Missing version: v1 (every CLI that omits it predates 2.x support).
- **Each set rejects the other version's routes**, so a false version claim cannot reach routes
  only the other version has. The v1 set is today's guards plus: reject every `/api/*` route
  that 1.18 does not serve (1.18 already serves about 51, e.g. `/api/pty`,
  `/api/session/:id/prompt`; list them from the pinned v1 submodule). The v2 allowlist rejects
  every 1.x legacy path.
- **v2 guard set = an always-on allowlist** of method + path, built from
  `packages/protocol/src/groups` or the generated client (the published `openapi.json` is
  incomplete, e.g. it lacks `POST /api/integration/{id}/connect/external`). It contains the
  operations the 2.0 web app uses for a chat session; each enabled feature adds its operations
  back. Always rejected regardless of toggles:
  - `POST /api/pair`, `GET /auth/connect/*` (would mint opencode's own 30-day sessions)
  - `PATCH /api/project/:id` with `commands.start` (startup script, runs `bash -lc` when a
    workspace is created)
  - `PATCH /api/experimental/config`, entirely: besides `shell` (any executable as the default
    shell), the config can define MCP servers and plugins, which run local commands. 2.x
    Settings changes that write the config fail with our message.
  - `PUT/DELETE /api/experimental/mcp/:server`, integration `connect/command` and
    `connect/external` (until verified), `POST /api/plugin/update` and `/check`,
    `POST /api/rpc/*`, credential create/update, persistent PTYs
  - `PUT /api/session/:id/environment`, and routes that inject input into a session
  - Allowed although outside any toggle: workspace create/remove/refresh, `vcs/init`, provider
    sign-in, MCP connect/disconnect of configured servers. The full classification is
    `api/src/v2-routes.ts`, checked against the submodule by a test.
- **Feature rules (v2)**, driven by the v2 toggles:

  | Feature | Rejected when disabled |
  |---|---|
  | uploads | `POST /api/experimental/fs/write` (only uploads use it); prompt/command `files` entries that are not `file:` URIs (top-level `files`, not 1.x `prompt.files`); `data:` project icons; `POST /api/experimental/session/import` |
  | terminal | `/api/pty*`, `/api/experimental/persistent-pty/*`, `/api/experimental/session/:id/terminal*` |
  | shell | `POST /api/session/:id/shell`, `/api/shell*` |
  | export | `GET /api/experimental/session/:id/export` (the app exports client-side from session reads, so the UI patch is the real control, as on 1.x) |
  | share | nothing: removed in 2.0 |

  When uploads are enabled, `fs/write` is allowed only under the server's temp uploads directory.
- **Rejection response:** `400` with `{"_tag":"FeatureDisabled","message":…}`; the 2.0 app shows
  the message. Never `401`: the app switches to its own connect-server screen. (`403` shows as
  "UnexpectedStatus: 403".)

### Deployment config

The existing `features` key keeps its meaning as the 1.x toggles, so current deployments are
unchanged. 2.x gets its own block:

```json
{
  "features": { "terminal": { "enabled": false } },
  "opencodeV2": {
    "versions": { "min": "2.0.20", "max": "2.0.27" },
    "features": { "terminal": { "enabled": true } }
  }
}
```

`opencodeV2.versions` may only narrow the build's default range (see "Version policy").

### UI

- **Routing.** The picker reads `opencodeVersion` per machine and links to `/s/<id>/` or
  `/v2/s/<id>/` (missing version → 1.x, since every CLI that omits it predates 2.x support). Each
  build checks the session's version on load and redirects to the other build on mismatch, so
  stale links keep working. Bump the UI ↔ API protocol for the new session field.
- **Base path.** The 2.x build needs Vite `base: "/v2/"`, a router base, nginx serving `/v2/`
  with its own SPA fallback, and the font/asset URL rewrite following it. On mobile, verify that
  Capacitor's local server serves `/v2/index.html` for `/v2/*` (it falls back to the root
  `index.html` for unknown paths).
- **v2 build** (spike: builds with Vite 6 and Vite 8, type-checks, loads to the login screen;
  no session tested):
  - Rename `@opencode-ai/` → `@opencode/` in the resolver, imports and tsconfig paths.
  - Drop removed `AppInterface` props (`defaultServer`, `disableHealthCheck`, `serverScoped`).
    Replace `AutoOpenProjects` with `useGlobal()` from `@opencode/app/desktop`, rendered as a child.
  - Alias `@betteroffice/fonts-cjk` as upstream's `vite.js` does.
  - Locale list path moved to `src/runtime/i18n/` (`ui/build/locales-config.ts`).
  - Uploads use `XMLHttpRequest` with a root-relative URL (`composer/attachments/destination.ts`),
    bypassing our fetch patch and the `/proxy/<sid>/` prefix. Fix in our code with an XHR wrapper
    (`installProxyXHR` next to `proxy-fetch.ts`) that rewrites the URL and adds the token; add
    token-refresh retry.
  - The app polls `GET /api/info` every 10 s and shows its connect screen on 401; the proxy must
    not surface our own 401s as opencode 401s.
  - Prefer Vite 8 (upstream's version; faster builds), not required.
- **v2 patches:**

  | Feature | Patch | Estimate |
  |---|---|---|
  | uploads | composer attachment config, attach command, "+" menu item, project icon upload | 1–1.5 d |
  | shell | shell-mode transition, `!` trigger, command, menu item | 0.5–1 d |
  | export | command, two menu items, context-tab button (gui-extensions) | 0.5 d |
  | terminal | remove `terminal` from gui-extensions `builtins` | 0.5 d |
  | share | none | — |

- **Office preview.** 2.0's built-in Office file preview adds ~40 MB of wasm and ~15 MB of fonts
  (v2 `dist` 91 MB vs 42 MB without). Kept as is for now; removing it or making it a v2 toggle is
  future work.

### Mobile

Both builds are bundled; the WebView routes the same way as the web UI. Estimated APK sizes
(compressed `dist` swapped into today's 18.5 MB debug APK, not built):

| Contents | APK |
|---|---|
| v1 only (today) | 18.5 MB (measured) |
| v1 + v2, with Office preview (this design) | ~51 MB |
| v1 + v2, Office preview removed (future) | ~30 MB |

### Version policy within 2.x

Each v2 UI build is pinned to one opencode version. 2.x has no API negotiation and released 27
versions in 27 days (v2.0.0–v2.0.26), with restructurings mid-line (v2.0.6 XHR upload, v2.0.22
features moved to extensions, v2.0.25 default-server option removed). A machine on a different
2.0.x than the build may or may not work.

Decided: a **supported range**, `min ≤ version < max` (min inclusive, so it can start at the
tested version; max exclusive).

- The repo holds a default range per v2 build in `config/opencode-versions.json`: the versions
  its patches were tested against. Empty (`"v2": null`) until the 2.x build exists (step 4).
- A deployment's `opencodeV2.versions` may narrow it, never widen it.
- The gateway rejects a version outside the range at `/tunnel` with a clear message, so a new
  range needs no new CLI. The UI checks only the major version (1.x vs 2.x build) and redirects;
  it does not repeat the range check.
- A mismatch inside the range can only break features, not bypass guards: the v2 allowlist
  rejects routes it does not list.

### Testing

- Unit: v2 guard set (allowlist, each feature rule, unknown-version fallback), CLI version
  parsing and v2 launch (start line, password, header injection, `auth_token` strip), XHR wrapper.
- `ui/build/upload-patches.test.ts` and siblings per version.
- e2e: the dev-machine pod runs one CLI per version (two sessions in one deployment); run the
  existing suites against both, plus picker routing and the redirect on mismatch. The v2 dev
  machine needs `@opencode/cli` installed separately from `opencode-ai`.

## Risks

- **Upstream churn.** Patched v2 files changed in 13 of 26 release steps (1.x: 13 of 35). Expect a
  patch fix roughly every other bump; a broken v2 patch blocks the shared release.
- **`opencode pair --remote`.** Any user can expose their machine through opentunnel.xyz,
  bypassing our edge (password-protected only). Outside opencode-rc; document it for admins
  (network or endpoint policy).
- **Shared data.** 1.x and 2.x use the same data directory and `opencode.db`; 2.0 migrates it in
  place. Unverified whether 1.x still works after 2.0 has touched it. Document for users.
- **Version claims.** The version comes from the user's CLI and cannot be verified. Each guard
  set rejects routes only the other version has, so a false claim cannot reach those. On routes
  both versions serve (e.g. `/api/pty`), a toggle set differently per version holds for normal
  clients but not against a user who modifies their CLI. Accepted: that user controls the dev
  machine anyway; toggles set the same in both versions stay fully enforced. Document it in the
  README's "Deployment Config".

## Effort (estimate)

~8–12 days for the v2 port (build, patches, guards, CLI), including 3–5 days of runtime and e2e
work against a 2.0 server, plus the dual-build routing, gateway field and base-path work.

## Decisions

Settled 2026-10-11:

1. One development stream on `main`, merged in steps (see "Repository layout").
2. Version policy: supported range `min ≤ version < max`, default per build, deployments may
   only narrow it, enforced by the gateway at registration; the UI checks only the major version.
3. Separate feature toggles per version (`features` for 1.x, `opencodeV2.features` for 2.x).
4. Version claims: each guard set rejects the other version's routes; the residual gap on shared
   routes is accepted and documented (see "Risks").
5. Office preview: kept for now; future work.
6. Vite 8 for both builds (`vite 8.2.2`, `vite-plugin-solid 2.11.14`, `tailwindcss` and
   `@tailwindcss/vite 4.3.3`, matching upstream v2). Checked against the v1 build: builds (6 s vs
   14 s on Vite 6, 32 MB vs 37 MB), builds with uploads/terminal patches applied, type-checks,
   210 unit tests pass on Node 22, login screen renders. Not yet run: e2e against a 1.x server.
   Vite 8 warns that `vite.config.ts` uses `__dirname` and extensionless imports, unsupported by
   its future native config loader; fix when upgrading.
