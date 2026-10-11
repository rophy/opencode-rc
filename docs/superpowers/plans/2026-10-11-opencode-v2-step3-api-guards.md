# opencode 2.0 Support, Step 3: API Guards per opencode Version

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API applies a guard set per opencode major version, chosen from the session's
`opencodeVersion` (missing or 1.x → v1 set; otherwise → v2 set). The v1 set is today's guards
plus a rejection of `/api/*` routes that opencode 1.18 does not serve. The v2 set is an
always-on allowlist of opencode 2.0.26's routes with its own feature toggles
(`opencodeV2.features` in config.json).

**Architecture:** Route tables are static TypeScript lists in `api/src/`, kept honest by tests
that parse each submodule's route definitions (`packages/protocol/src/groups/*.ts`) and require
an exact match. `vendor/opencode-v2` (pinned v2.0.26) is added now for those tests; the 2.x UI
build comes in step 4. Guards are Hono middlewares on `/proxy/:sessionId/*`, running after
`sessionAccess` (which sets `c.get("session")`) and before the WebSocket relay.

**Tech Stack:** Bun + Hono + vitest 5 (API), TypeScript schema shared by UI and API, git submodules.

**Spec:** `docs/superpowers/specs/2026-10-11-opencode-v2-support-design.md` (section "API").

**Decisions for this step (agreed with the user):**
- `vendor/opencode-v2` is added in step 3 (route tests), not step 4.
- Allowed although outside any toggle: `POST/DELETE /api/worktree`, `POST /api/worktree/refresh`,
  `POST /api/vcs/init`, provider sign-in (integration `connect/key`, `connect/oauth`, OAuth
  complete/cancel, credential activate/delete), MCP connect/disconnect of configured servers.
- Blocked until verified: integration `connect/external` (and `connect/command`).
- v2 rejections: `400 {"_tag":"FeatureDisabled","message":...}`. v1 rejections stay `403` text.
- README documentation of `opencodeV2` waits for step 4.

**Controller ruling (flag to the user in the step report):** `PATCH /api/experimental/config` is
blocked entirely for 2.x, not only when it sets `shell`: the config can also define MCP servers
and plugins, which run local commands. Cost: 2.x Settings changes that write the config fail
with our message.

## Global Constraints

- Work in the worktree `.claude/worktrees/staging+v2` on branch `staging/v2`. Never push; never merge.
- 1.x sessions: today's guards keep working unchanged; the only new 1.x rejection is `/api/*`
  routes not in opencode 1.18's route list. Because the v1 set now always has a guard, write
  requests on 1.x sessions always need plain paths (`plainPath`), even with every feature enabled.
- Session version selection: `opencodeVersion` missing or matching `/^1\./` → v1 set; anything else → v2 set.
- v2 rejection response (verbatim shape): HTTP 400, JSON `{"_tag":"FeatureDisabled","message":"<text>"}`. Never 401 or 403 for v2.
- v2 feature names (verbatim): `uploads`, `terminal`, `shell`, `export`. Config key: `opencodeV2.features.<name>.enabled` (default true). Unknown keys are errors, as for `features`.
- Route tables must equal the submodules' route definitions exactly (tests enforce it).
- Package managers: bun in `api/`, `ui/`. Tests on Node 22: `npx -y node@22 node_modules/vitest/vitest.mjs run`.
- Commit messages: `<type>: <short description>`; no attribution lines, no mention of Claude. GPG signing is automatic; never disable it.
- No version bumps. Committed text must not name `.local/`, `LOCAL.md`, private hostnames or IPs.

---

### Task 1: Add `vendor/opencode-v2` and a route parser for tests

**Files:**
- Add submodule: `vendor/opencode-v2` (https://github.com/anomalyco/opencode.git, tag `v2.0.26`)
- Create: `api/src/opencode-routes.testutil.ts`, `api/src/opencode-routes.test.ts`
- Modify: `.github/workflows/api.yml` (test job checks out submodules)
- Modify: `AGENTS.md`, `CONTRIBUTING.md` (structure listing and submodule section: two submodules)

**Interfaces:**
- Produces: `protocolRoutes(opencodeRoot: string): { method: string; path: string }[]` — every
  `HttpApiEndpoint.<method>("<name>", <path>, ...)` in `<root>/packages/protocol/src/groups/*.ts`,
  method upper-cased, path as written in the source with `const x = "..."` and `${x}` resolved.
  Tasks 3 and 4 use it.

- [ ] **Step 1: Add the submodule**

```bash
git submodule add https://github.com/anomalyco/opencode.git vendor/opencode-v2
git -C vendor/opencode-v2 checkout v2.0.26
git add .gitmodules vendor/opencode-v2
git -C vendor/opencode-v2 describe --tags   # v2.0.26
```

Do not run `bun install` in it (not needed for this step; it would also set git hooks).

- [ ] **Step 2: Failing test for the parser**

`api/src/opencode-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { protocolRoutes } from "./opencode-routes.testutil.js";

const v1 = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url));
const v2 = fileURLToPath(new URL("../../vendor/opencode-v2", import.meta.url));

describe("protocolRoutes", () => {
  it("reads every opencode 2.0.26 operation", () => {
    const routes = protocolRoutes(v2);
    expect(routes).toHaveLength(142);
    expect(routes).toContainEqual({ method: "POST", path: "/api/session/:sessionID/prompt" });
    // Paths built from a `const root = "/api/worktree"` and `${root}/refresh`
    expect(routes).toContainEqual({ method: "POST", path: "/api/worktree" });
    expect(routes).toContainEqual({ method: "POST", path: "/api/worktree/refresh" });
    expect(routes).toContainEqual({ method: "PATCH", path: "/api/project/:projectID" });
    // Endpoints whose call spans several lines
    expect(routes).toContainEqual({ method: "POST", path: "/api/integration/:integrationID/connect/external" });
  });

  it("reads opencode 1.18's /api operations", () => {
    const api = protocolRoutes(v1).filter((r) => r.path.startsWith("/api/"));
    expect(api).toHaveLength(58);
    expect(api).toContainEqual({ method: "POST", path: "/api/pty" });
  });
});
```

Run: `cd api && npx -y node@22 node_modules/vitest/vitest.mjs run src/opencode-routes.test.ts` → FAIL (module missing).
These tests must FAIL (not skip) if a submodule is missing: do not add `skipIf`.

- [ ] **Step 3: Implement the parser**

`api/src/opencode-routes.testutil.ts`:

```ts
// Test support: the HTTP routes an opencode checkout defines, read from its protocol package
// (packages/protocol/src/groups/*.ts, where every endpoint is an HttpApiEndpoint.<method>(name,
// path, ...) call). The route tables in v1-routes.ts and v2-routes.ts are checked against it.
import fs from "node:fs";
import path from "node:path";

const ENDPOINT = /HttpApiEndpoint\.(get|post|put|patch|delete)\(\s*"[^"]+",\s*(?:"([^"]*)"|`([^`]*)`|([A-Za-z_]\w*))/g;

export function protocolRoutes(opencodeRoot: string): { method: string; path: string }[] {
  const dir = path.join(opencodeRoot, "packages/protocol/src/groups");
  const out: { method: string; path: string }[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const consts = Object.fromEntries([...source.matchAll(/const (\w+) = "([^"]+)"/g)].map((m) => [m[1], m[2]]));
    for (const m of source.matchAll(ENDPOINT)) {
      const raw = m[2] ?? m[3] ?? consts[m[4]];
      if (raw === undefined) throw new Error(`${file}: cannot resolve path ${m[4]}`);
      const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
        if (!(name in consts)) throw new Error(`${file}: cannot resolve \${${name}}`);
        return consts[name];
      });
      out.push({ method: m[1].toUpperCase(), path: resolved });
    }
  }
  return out;
}
```

Run the test → PASS. (If the 142/58 counts differ, stop and report: the counts were taken from
the pinned tags.)

- [ ] **Step 4: CI and docs**

`.github/workflows/api.yml`, test job's checkout:

```yaml
      - uses: actions/checkout@v5
        with:
          submodules: true
```

AGENTS.md and CONTRIBUTING.md: the structure listing gets
`vendor/opencode-v2 # Git submodule — upstream opencode 2.x source (route tables; UI build in a later step)`
(align the `#` column of the whole listing, also fixing the step-1 misalignment). The submodule
section says there are two submodules (`vendor/opencode-v1` pinned to a 1.x tag,
`vendor/opencode-v2` pinned to a 2.x tag), and the bump commands show both. Replace AGENTS.md's
sentence saying 2.x support "(a second submodule) is in progress" accordingly.

- [ ] **Step 5: Run the API suite and commit**

```bash
cd api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
git add .gitmodules vendor/opencode-v2 api/src/opencode-routes.testutil.ts api/src/opencode-routes.test.ts .github/workflows/api.yml AGENTS.md CONTRIBUTING.md
git commit -m "build: add the opencode 2.x submodule for the API's route tables"
```

Expected: 323 + 2 tests pass.

---

### Task 2: `opencodeV2.features` in the deployment config

**Files:**
- Modify: `config/schema.ts`
- Test: `api/src/rc-config.test.ts` (or wherever `parseConfig` is tested; follow the existing tests)

**Interfaces:**
- Produces: `FEATURES_V2 = ["uploads", "terminal", "shell", "export"] as const`, `type FeatureNameV2`,
  and `RcConfig.opencodeV2: { features: Record<FeatureNameV2, { enabled: boolean }> }` (always
  present after parsing, all enabled by default). Task 4 reads it.

- [ ] **Step 1: Failing tests**

Add tests that:
- `parseConfig({})` returns `opencodeV2.features` with all four enabled;
- `parseConfig({ opencodeV2: { features: { terminal: { enabled: false } } } })` disables only terminal;
- `parseConfig({ opencodeV2: { features: { share: { enabled: false } } } })` throws `unknown key "opencodeV2.features.share"`;
- `parseConfig({ opencodeV2: { other: 1 } })` throws `unknown key "opencodeV2.other"`;
- `parseConfig({ opencodeV2: [] })` throws `opencodeV2 must be an object`;
- `features` (1.x) keeps working and is independent of `opencodeV2.features`.

- [ ] **Step 2: Implement**

In `config/schema.ts`: add `FEATURES_V2` and `FeatureNameV2` next to `FEATURES` (comment: the
2.x feature toggles; a disabled feature gets the 2.x UI patches in `vendor/patches/v2/<name>/`
(step 4) and the API's v2 rules in `api/src/v2-guard.ts`). Extend `RcConfig` with
`opencodeV2: { features: Record<FeatureNameV2, { enabled: boolean }> }`. In `parseConfig`, allow
the top-level key `opencodeV2`; it must be an object with only `features`; parse its features
with the existing `feature()` helper and `only(..., [...FEATURES_V2], "opencodeV2.features.")`.
Update the file's top comment to say 1.x features live under `features` and 2.x under
`opencodeV2.features`.

- [ ] **Step 3: Run tests (api and ui, since both import the schema) and commit**

```bash
cd api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
cd ../ui && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
git add config/schema.ts api/src
git commit -m "feat(config): separate feature toggles for opencode 2.x"
```

---

### Task 3: v1 set — reject `/api/*` routes opencode 1.18 does not serve

**Files:**
- Create: `api/src/route-template.ts`, `api/src/route-template.test.ts`
- Create: `api/src/v1-routes.ts`, `api/src/v1-routes.test.ts`
- Modify: `api/src/feature-guards.ts` (export a v1 guard chain), `api/src/feature-guards.test.ts`

**Interfaces:**
- Produces: `templateRegex(template: string): RegExp` (lower-case, `:param` = one segment,
  trailing `/*` = the rest); `V1_API_ROUTES`; `v1ApiGuard(): Guard`;
  `v1Guards(config: RcConfig, guards?: Record<FeatureName, Guard | null>): Guard` =
  `every(plainPath, v1ApiGuard(), ...disabled feature guards)`. Task 5 uses `v1Guards`.

- [ ] **Step 1: Failing tests**

`api/src/route-template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { templateRegex } from "./route-template.js";

describe("templateRegex", () => {
  it("matches one segment per parameter", () => {
    const re = templateRegex("/api/session/:sessionID/prompt");
    expect(re.test("/api/session/abc/prompt")).toBe(true);
    expect(re.test("/api/session/a/b/prompt")).toBe(false);
    expect(re.test("/api/session//prompt")).toBe(false);
    expect(re.test("/api/session/abc/prompt/x")).toBe(false);
  });
  it("matches the rest of the path for a trailing *", () => {
    const re = templateRegex("/api/fs/read/*");
    expect(re.test("/api/fs/read/src/a.ts")).toBe(true);
    expect(re.test("/api/fs/read/")).toBe(false);
  });
  it("is lower-case, for canonical paths", () => {
    expect(templateRegex("/api/session/:sessionID").test("/api/session/x")).toBe(true);
    expect(templateRegex("/api/experimental/session/import").source).toBe(templateRegex("/api/experimental/session/import").source.toLowerCase());
  });
});
```

`api/src/v1-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { protocolRoutes } from "./opencode-routes.testutil.js";
import { V1_API_ROUTES } from "./v1-routes.js";

const v1 = fileURLToPath(new URL("../../vendor/opencode-v1", import.meta.url));
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("V1_API_ROUTES", () => {
  it("is exactly opencode 1.x's /api routes (update it when bumping vendor/opencode-v1)", () => {
    const source = protocolRoutes(v1).filter((r) => r.path.startsWith("/api/")).map(key).sort();
    const table = V1_API_ROUTES.map(([method, path]) => key({ method, path })).sort();
    expect(table).toEqual(source);
  });
});
```

In `api/src/feature-guards.test.ts`, add tests for `v1Guards` with every feature enabled
(follow the file's `makeApp` pattern; the app must set `c.set("session", ...)` before the guard
if the guard reads it — `v1Guards` does not):
- `GET /proxy/s/session` (legacy 1.x path) → passes;
- `GET /proxy/s/api/session/abc/message` → passes (in 1.18's table);
- `POST /proxy/s/api/experimental/fs/write` → 403 (not a 1.18 route);
- `POST /proxy/s/api/shell` → 403;
- `GET /proxy/s/API/Pty` → canonicalized and allowed only if `GET /api/pty` is in the table (it is);
- `GET /proxy/s/api/%zz` → rejected (undecodable path);
- with `terminal` disabled, `POST /proxy/s/api/pty` → 403 from the terminal guard (still applied).

- [ ] **Step 2: Implement**

`api/src/route-template.ts`:

```ts
// A route template as opencode writes it ("/api/session/:sessionID/prompt", "/api/fs/read/*")
// as a regex for canonical paths (see canonicalPath in proxy.ts: decoded and lower-case).
export function templateRegex(template: string): RegExp {
  const segments = template.toLowerCase().split("/").map((seg) => {
    if (seg === "*") return ".+";
    if (seg.startsWith(":")) return "[^/]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segments.join("/")}$`);
}
```

`api/src/v1-routes.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";
import { templateRegex } from "./route-template.js";

// The /api routes opencode 1.x serves (vendor/opencode-v1, packages/protocol). Its legacy
// routes (/session, /pty, ...) are not listed: those pass through the v1 feature guards as
// before. v1-routes.test.ts keeps this list equal to the submodule's.
export const V1_API_ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/api/agent"],
  ["GET", "/api/command"],
  ["DELETE", "/api/credential/:credentialID"],
  ["PATCH", "/api/credential/:credentialID"],
  ["GET", "/api/event"],
  ["GET", "/api/fs/find"],
  ["GET", "/api/fs/list"],
  ["GET", "/api/fs/read/*"],
  ["GET", "/api/health"],
  ["GET", "/api/integration"],
  ["GET", "/api/integration/:integrationID"],
  ["POST", "/api/integration/:integrationID/connect/key"],
  ["POST", "/api/integration/:integrationID/connect/oauth"],
  ["DELETE", "/api/integration/attempt/:attemptID"],
  ["GET", "/api/integration/attempt/:attemptID"],
  ["POST", "/api/integration/attempt/:attemptID/complete"],
  ["GET", "/api/location"],
  ["GET", "/api/model"],
  ["GET", "/api/permission/request"],
  ["GET", "/api/permission/saved"],
  ["DELETE", "/api/permission/saved/:id"],
  ["GET", "/api/provider"],
  ["GET", "/api/provider/:providerID"],
  ["GET", "/api/pty"],
  ["POST", "/api/pty"],
  ["DELETE", "/api/pty/:ptyID"],
  ["GET", "/api/pty/:ptyID"],
  ["PUT", "/api/pty/:ptyID"],
  ["GET", "/api/pty/:ptyID/connect"],
  ["POST", "/api/pty/:ptyID/connect-token"],
  ["GET", "/api/question/request"],
  ["GET", "/api/reference"],
  ["GET", "/api/session"],
  ["POST", "/api/session"],
  ["GET", "/api/session/:sessionID"],
  ["POST", "/api/session/:sessionID/agent"],
  ["POST", "/api/session/:sessionID/compact"],
  ["GET", "/api/session/:sessionID/context"],
  ["GET", "/api/session/:sessionID/event"],
  ["GET", "/api/session/:sessionID/history"],
  ["POST", "/api/session/:sessionID/interrupt"],
  ["GET", "/api/session/:sessionID/message"],
  ["GET", "/api/session/:sessionID/message/:messageID"],
  ["POST", "/api/session/:sessionID/model"],
  ["GET", "/api/session/:sessionID/permission"],
  ["POST", "/api/session/:sessionID/permission"],
  ["GET", "/api/session/:sessionID/permission/:requestID"],
  ["POST", "/api/session/:sessionID/permission/:requestID/reply"],
  ["POST", "/api/session/:sessionID/prompt"],
  ["GET", "/api/session/:sessionID/question"],
  ["POST", "/api/session/:sessionID/question/:requestID/reject"],
  ["POST", "/api/session/:sessionID/question/:requestID/reply"],
  ["POST", "/api/session/:sessionID/revert/clear"],
  ["POST", "/api/session/:sessionID/revert/commit"],
  ["POST", "/api/session/:sessionID/revert/stage"],
  ["POST", "/api/session/:sessionID/wait"],
  ["GET", "/api/session/active"],
  ["GET", "/api/skill"],
];

const V1_API = V1_API_ROUTES.map(([method, path]) => ({ method, re: templateRegex(path) }));

// A 1.x session may use only the /api routes 1.x has. A session that reports 1.x but runs
// something else (a modified CLI) then cannot reach routes only 2.x has, such as
// POST /api/experimental/fs/write or POST /api/shell.
export function v1ApiGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!);
    const path = canonicalPath(rest);
    if (path === null) {
      console.log(`v1 guard: blocked user=${c.get("userId")} ${c.req.method} undecodable path`);
      return c.text("unsupported characters in path", 400);
    }
    if (path !== "/api" && !path.startsWith("/api/")) return next();
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (method === "OPTIONS" || V1_API.some((r) => r.method === method && r.re.test(path.replace(/\/+$/, "")))) {
      return next();
    }
    console.log(`v1 guard: blocked user=${c.get("userId")} ${c.req.method} ${path}`);
    return c.text("this opencode route is not available through opencode-rc", 403);
  };
}
```

`api/src/feature-guards.ts`: add

```ts
// The guard set for opencode 1.x sessions: the /api route check plus the guards of the
// features the config disables (FEATURES order). Always active, so writes need plain paths.
export function v1Guards(config: RcConfig, guards: Record<FeatureName, Guard | null> = FEATURE_GUARDS): Guard {
  const active = FEATURES.filter((name) => !config.features[name].enabled)
    .map((name) => guards[name])
    .filter((guard): guard is Guard => guard !== null);
  return every(plainPath, v1ApiGuard(), ...active);
}
```

Keep `featureGuards` for now (Task 5 replaces its use in `index.ts`); update its tests only if
they break.

If the CORS middleware already answers `OPTIONS` before `/proxy` (check `api/src/origins.ts` /
`index.ts`), say so in the report; the `OPTIONS` pass-through stays as a harmless default.

- [ ] **Step 3: Run tests and commit**

```bash
cd api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
git add api/src
git commit -m "feat(api): reject /api routes opencode 1.x does not serve on 1.x sessions"
```

---

### Task 4: v2 set — the 2.0.26 allowlist

**Files:**
- Create: `api/src/v2-routes.ts`, `api/src/v2-routes.test.ts`
- Create: `api/src/v2-guard.ts`, `api/src/v2-guard.test.ts`

**Interfaces:**
- Consumes: `templateRegex` (Task 3), `FEATURES_V2`/`RcConfig.opencodeV2` (Task 2),
  `protocolRoutes` (Task 1), `canonicalPath`/`proxyRest`/`upstreamUrl`/`ProxyEnv` (proxy.ts),
  `plainPath` (feature-guards.ts).
- Produces: `V2_ROUTES`; `v2Guard(features: RcConfig["opencodeV2"]["features"], deps?: { fetchServerInfo?: ... }): Guard`;
  `v2Guards(config: RcConfig): Guard` = `every(plainPath, v2Guard(config.opencodeV2.features))`. Task 5 uses `v2Guards`.

- [ ] **Step 1: The route table**

`api/src/v2-routes.ts`:

```ts
import type { FeatureNameV2 } from "../../config/schema.js";

// What opencode-rc lets through for each opencode 2.x route (vendor/opencode-v2, packages/
// protocol): "allow", "never", or the 2.x feature it belongs to (allowed while enabled).
// v2-routes.test.ts keeps this list equal to the submodule's, so a bump that adds a route fails
// until it is classified here. Body and query checks for some allowed routes live in v2-guard.ts.
//
// never: runs commands, writes outside the workspace, changes the server or its config,
// injects input into a session, or mints opencode's own logins (pairing).
export type V2Rule = "allow" | "never" | FeatureNameV2;

export const V2_ROUTES: readonly (readonly [string, string, V2Rule])[] = [
  ["GET", "/api/agent", "allow"], // agent.list
  ["GET", "/api/agent/:agentID", "allow"], // agent.get
  ["GET", "/api/command", "allow"], // command.list
  ["GET", "/api/config", "allow"], // config.get
  ["GET", "/api/config/shell", "allow"], // config.shells
  ["GET", "/api/credential", "allow"], // credential.list
  ["POST", "/api/credential", "never"], // credential.create
  ["DELETE", "/api/credential/:credentialID", "allow"], // credential.remove
  ["PATCH", "/api/credential/:credentialID", "never"], // credential.update
  ["POST", "/api/credential/:credentialID/activate", "allow"], // credential.activate
  ["DELETE", "/api/debug/location", "never"], // debug.location.evict
  ["GET", "/api/debug/location", "allow"], // debug.location
  ["GET", "/api/event", "allow"], // event.subscribe
  ["PATCH", "/api/experimental/config", "never"], // config.update
  ["POST", "/api/experimental/fs/write", "uploads"], // fs.write
  ["POST", "/api/experimental/generate", "never"], // generate.text
  ["POST", "/api/experimental/integration/wellknown", "never"], // integration.wellknown.add
  ["DELETE", "/api/experimental/mcp/:server", "never"], // mcp.remove
  ["PUT", "/api/experimental/mcp/:server", "never"], // mcp.add
  ["POST", "/api/experimental/mcp/:server/connect", "allow"], // mcp.connect
  ["POST", "/api/experimental/mcp/:server/disconnect", "allow"], // mcp.disconnect
  ["GET", "/api/experimental/migration/v1", "allow"], // migration.v1.status
  ["DELETE", "/api/experimental/persistent-pty/:ptyID", "never"], // persistentPty.remove
  ["GET", "/api/experimental/persistent-pty/:ptyID", "never"], // persistentPty.get
  ["PUT", "/api/experimental/persistent-pty/:ptyID", "never"], // persistentPty.update
  ["GET", "/api/experimental/persistent-pty/:ptyID/connect", "never"], // persistentPty.connect
  ["POST", "/api/experimental/persistent-pty/:ptyID/connect-token", "never"], // persistentPty.connectToken
  ["GET", "/api/experimental/persistent-pty/:ptyID/snapshot", "never"], // persistentPty.snapshot
  ["POST", "/api/experimental/persistent-pty/handoff", "never"], // persistentPty.handoff
  ["POST", "/api/experimental/persistent-pty/shutdown", "never"], // persistentPty.shutdown
  ["GET", "/api/experimental/session/:sessionID/export", "export"], // session.export
  ["GET", "/api/experimental/session/:sessionID/instructions/entries", "allow"], // session.instructions.entry.list
  ["DELETE", "/api/experimental/session/:sessionID/instructions/entries/:key", "never"], // session.instructions.entry.remove
  ["PUT", "/api/experimental/session/:sessionID/instructions/entries/:key", "never"], // session.instructions.entry.put
  ["GET", "/api/experimental/session/:sessionID/log", "allow"], // session.log
  ["POST", "/api/experimental/session/:sessionID/skill", "never"], // session.skill
  ["GET", "/api/experimental/session/:sessionID/terminal", "never"], // persistentPty.list
  ["POST", "/api/experimental/session/:sessionID/terminal", "never"], // persistentPty.create
  ["GET", "/api/experimental/session/:sessionID/terminal/read", "never"], // persistentPty.read
  ["POST", "/api/experimental/session/:sessionID/wait", "allow"], // session.wait
  ["POST", "/api/experimental/session/import", "uploads"], // session.import
  ["GET", "/api/experimental/session/stats", "allow"], // session.stats
  ["GET", "/api/form", "allow"], // form.list
  ["GET", "/api/fs/find", "allow"], // fs.find
  ["GET", "/api/fs/list", "allow"], // fs.list
  ["GET", "/api/fs/read/*", "allow"], // fs.read
  ["GET", "/api/info", "allow"], // server.info
  ["GET", "/api/integration", "allow"], // integration.list
  ["GET", "/api/integration/:integrationID", "allow"], // integration.get
  ["POST", "/api/integration/:integrationID/connect/command", "never"], // integration.command.connect
  ["DELETE", "/api/integration/:integrationID/connect/command/:attemptID", "never"], // integration.command.cancel
  ["GET", "/api/integration/:integrationID/connect/command/:attemptID", "never"], // integration.command.status
  ["POST", "/api/integration/:integrationID/connect/external", "never"], // integration.connect.external
  ["POST", "/api/integration/:integrationID/connect/key", "allow"], // integration.connect.key
  ["POST", "/api/integration/:integrationID/connect/oauth", "allow"], // integration.oauth.connect
  ["DELETE", "/api/integration/:integrationID/connect/oauth/:attemptID", "allow"], // integration.oauth.cancel
  ["GET", "/api/integration/:integrationID/connect/oauth/:attemptID", "allow"], // integration.oauth.status
  ["POST", "/api/integration/:integrationID/connect/oauth/:attemptID/complete", "allow"], // integration.oauth.complete
  ["GET", "/api/location", "allow"], // location.get
  ["POST", "/api/location/reload", "never"], // location.reload
  ["GET", "/api/mcp", "allow"], // mcp.list
  ["GET", "/api/mcp/resource", "allow"], // mcp.resource.catalog
  ["GET", "/api/model", "allow"], // model.list
  ["GET", "/api/model/default", "allow"], // model.default
  ["POST", "/api/pair", "never"], // server.pair
  ["GET", "/api/permission/request", "allow"], // permission.request.list
  ["GET", "/api/permission/saved", "allow"], // permission.saved.list
  ["DELETE", "/api/permission/saved/:id", "allow"], // permission.saved.remove
  ["GET", "/api/plugin", "allow"], // plugin.list
  ["POST", "/api/plugin/check", "never"], // plugin.check
  ["POST", "/api/plugin/update", "never"], // plugin.update
  ["GET", "/api/project", "allow"], // project.list
  ["PATCH", "/api/project/:projectID", "allow"], // project.update
  ["GET", "/api/provider", "allow"], // provider.list
  ["GET", "/api/provider/:providerID", "allow"], // provider.get
  ["GET", "/api/pty", "terminal"], // pty.list
  ["POST", "/api/pty", "terminal"], // pty.create
  ["DELETE", "/api/pty/:ptyID", "terminal"], // pty.remove
  ["GET", "/api/pty/:ptyID", "terminal"], // pty.get
  ["PUT", "/api/pty/:ptyID", "terminal"], // pty.update
  ["GET", "/api/pty/:ptyID/connect", "terminal"], // pty.connect
  ["POST", "/api/pty/:ptyID/connect-token", "terminal"], // pty.connectToken
  ["GET", "/api/reference", "allow"], // reference.list
  ["POST", "/api/rpc/:rpcID/:method", "never"], // rpc.call
  ["GET", "/api/session", "allow"], // session.list
  ["POST", "/api/session", "allow"], // session.create
  ["DELETE", "/api/session/:sessionID", "allow"], // session.remove
  ["GET", "/api/session/:sessionID", "allow"], // session.get
  ["PATCH", "/api/session/:sessionID", "allow"], // session.update
  ["POST", "/api/session/:sessionID/agent", "allow"], // session.switchAgent
  ["POST", "/api/session/:sessionID/background", "allow"], // session.background
  ["POST", "/api/session/:sessionID/command", "allow"], // session.command
  ["POST", "/api/session/:sessionID/compact", "allow"], // session.compact
  ["GET", "/api/session/:sessionID/context", "allow"], // session.context
  ["GET", "/api/session/:sessionID/diff", "allow"], // session.diff
  ["PUT", "/api/session/:sessionID/environment", "never"], // session.environment
  ["POST", "/api/session/:sessionID/fork", "allow"], // session.fork
  ["GET", "/api/session/:sessionID/form", "allow"], // session.form.list
  ["POST", "/api/session/:sessionID/form", "never"], // session.form.create
  ["DELETE", "/api/session/:sessionID/form/:formID", "allow"], // session.form.cancel
  ["GET", "/api/session/:sessionID/form/:formID", "allow"], // session.form.get
  ["POST", "/api/session/:sessionID/form/:formID/reply", "allow"], // session.form.reply
  ["POST", "/api/session/:sessionID/generate", "allow"], // session.generate
  ["GET", "/api/session/:sessionID/inbox", "allow"], // session.inbox.list
  ["DELETE", "/api/session/:sessionID/inbox/:inboxID", "allow"], // session.inbox.cancel
  ["PATCH", "/api/session/:sessionID/inbox/:inboxID", "allow"], // session.inbox.update
  ["POST", "/api/session/:sessionID/interrupt", "allow"], // session.interrupt
  ["GET", "/api/session/:sessionID/message", "allow"], // session.messages
  ["GET", "/api/session/:sessionID/message/:messageID", "allow"], // session.message
  ["POST", "/api/session/:sessionID/model", "allow"], // session.switchModel
  ["POST", "/api/session/:sessionID/move", "allow"], // session.move
  ["GET", "/api/session/:sessionID/permission", "allow"], // session.permission.list
  ["POST", "/api/session/:sessionID/permission", "never"], // session.permission.create
  ["GET", "/api/session/:sessionID/permission/:requestID", "allow"], // session.permission.get
  ["POST", "/api/session/:sessionID/permission/:requestID/reply", "allow"], // session.permission.reply
  ["POST", "/api/session/:sessionID/prompt", "allow"], // session.prompt
  ["DELETE", "/api/session/:sessionID/revert", "allow"], // session.revert.clear
  ["POST", "/api/session/:sessionID/revert/commit", "allow"], // session.revert.commit
  ["POST", "/api/session/:sessionID/revert/stage", "allow"], // session.revert.stage
  ["POST", "/api/session/:sessionID/shell", "shell"], // session.shell
  ["POST", "/api/session/:sessionID/synthetic", "never"], // session.synthetic
  ["POST", "/api/session/:sessionID/view", "never"], // session.view
  ["GET", "/api/session/active", "allow"], // session.active
  ["GET", "/api/shell", "allow"], // shell.list
  ["POST", "/api/shell", "never"], // shell.create
  ["DELETE", "/api/shell/:id", "allow"], // shell.remove
  ["GET", "/api/shell/:id", "allow"], // shell.get
  ["GET", "/api/shell/:id/output", "allow"], // shell.output
  ["GET", "/api/skill", "allow"], // skill.list
  ["GET", "/api/vcs", "allow"], // vcs.get
  ["GET", "/api/vcs/base", "allow"], // vcs.base
  ["GET", "/api/vcs/branch", "allow"], // vcs.branch.list
  ["GET", "/api/vcs/diff", "allow"], // vcs.diff
  ["POST", "/api/vcs/init", "allow"], // vcs.init
  ["GET", "/api/vcs/status", "allow"], // vcs.status
  ["POST", "/api/websearch", "never"], // websearch.query
  ["GET", "/api/websearch/provider", "allow"], // websearch.providers
  ["DELETE", "/api/worktree", "allow"], // worktree.remove
  ["GET", "/api/worktree", "allow"], // worktree.list
  ["POST", "/api/worktree", "allow"], // worktree.create
  ["POST", "/api/worktree/refresh", "allow"], // worktree.refresh
  ["GET", "/auth/connect/:code", "never"], // server.connect
];
```

`api/src/v2-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { protocolRoutes } from "./opencode-routes.testutil.js";
import { V2_ROUTES } from "./v2-routes.js";

const v2 = fileURLToPath(new URL("../../vendor/opencode-v2", import.meta.url));
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("V2_ROUTES", () => {
  it("classifies exactly opencode 2.x's routes (update it when bumping vendor/opencode-v2)", () => {
    const source = protocolRoutes(v2).map(key).sort();
    const table = V2_ROUTES.map(([method, path]) => key({ method, path })).sort();
    expect(table).toEqual(source);
  });

  it("lists each route once", () => {
    const keys = V2_ROUTES.map(([method, path]) => `${method} ${path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

Run → PASS once the table is in.

- [ ] **Step 2: Failing guard tests**

`api/src/v2-guard.test.ts`. Build a Hono app that sets `userId`, `token` and a `session`
(`{ id: "s", userId: "u", directory: "/w", gatewayAddr: "gw:9090", createdAt: "", opencodeVersion: "2.0.26" }`)
and mounts `/proxy/:sessionId/*` → `v2Guards(config)` → a handler returning `200 "forwarded"`
plus the body it would forward (`c.get("body")` decoded, or the raw body). Follow the existing
`makeApp` helpers in `feature-guards.test.ts`/`upload-guard.test.ts`. For `fs/write`, inject
`fetchServerInfo` returning `{ paths: { tmp: "/tmp/oc" } }`. Cases (all features enabled unless
stated; "rejected" = status 400 and JSON `_tag` `FeatureDisabled` with a non-empty `message`):

1. `GET /api/session` → forwarded. `GET /api/fs/read/src/a.ts` → forwarded. `GET /API/Session` → forwarded (canonical).
2. `GET /session` (a 1.x legacy path) → rejected. `GET /unknown` → rejected.
3. `POST /api/shell` → rejected. `PATCH /api/experimental/config` → rejected. `POST /api/pair` → rejected. `GET /auth/connect/abc` → rejected. `PUT /api/experimental/mcp/x` → rejected. `POST /api/integration/i/connect/external` → rejected. `GET /api/experimental/persistent-pty/p` → rejected.
4. terminal: enabled → `POST /api/pty` and `GET /api/pty/p/connect` forwarded; disabled → both rejected, message mentions the terminal.
5. shell: disabled → `POST /api/session/x/shell` rejected; enabled → forwarded.
6. export: disabled → `GET /api/experimental/session/x/export` rejected; enabled → forwarded.
7. `PATCH /api/project/p` with `{"name":"x"}` → forwarded with the same body; with `{"commands":{"start":"rm -rf ~"}}` → rejected (any `commands` key), whatever the toggles.
8. uploads disabled:
   - `POST /api/experimental/fs/write?path=/tmp/oc/uploads/u/f.txt` → rejected;
   - `POST /api/experimental/session/import` → rejected;
   - `POST /api/session/x/prompt` with `{"files":[{"uri":"data:image/png;base64,AA"}]}` → rejected; with `{"files":[{"uri":"file:///w/a.ts"}]}` → forwarded; with `{"text":"hi"}` → forwarded;
   - `POST /api/session/x/command` with a `data:` file → rejected;
   - `PATCH /api/project/p` with `{"icon":{"override":"data:image/png;base64,AA"}}` → rejected.
9. uploads enabled, `fs/write`:
   - `path=/tmp/oc/uploads/u/f.txt` → forwarded;
   - `path=/home/u/.bashrc` → rejected;
   - `path=/tmp/oc/uploads/../../etc/x` → rejected;
   - `path=/tmp/ocx/uploads/u/f` → rejected (prefix must end at a `/`);
   - missing `path` → rejected;
   - `fetchServerInfo` throws → rejected (fails closed).
10. A write with a non-plain path (`POST /api/session/a%2fb/prompt`) → 400 from `plainPath` (text, as today).
11. `HEAD /api/session` behaves like `GET`; `OPTIONS /api/anything` → forwarded.

- [ ] **Step 3: Implement**

`api/src/v2-guard.ts` (complete the helpers as described; keep it one focused file):

```ts
import type { Context, MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import type { FeatureNameV2, RcConfig } from "../../config/schema.js";
import { plainPath } from "./feature-guards.js";
import { canonicalPath, proxyRest, upstreamUrl, type ProxyEnv } from "./proxy.js";
import { templateRegex } from "./route-template.js";
import { V2_ROUTES } from "./v2-routes.js";

type Guard = MiddlewareHandler<ProxyEnv>;
type Features = RcConfig["opencodeV2"]["features"];
type ServerInfo = { paths?: { tmp?: unknown } };

const ROUTES = V2_ROUTES.map(([method, template, rule]) => ({ method, template, rule, re: templateRegex(template) }));

const MESSAGES: Record<FeatureNameV2, string> = {
  uploads: "uploads are disabled",
  terminal: "the terminal is disabled",
  shell: "shell commands are disabled",
  export: "export is disabled",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFileUri = (v: unknown) => typeof v === "string" && v.toLowerCase().startsWith("file:");

// 400 with the error shape opencode 2.x's client shows to the user ({_tag, message}); a 401
// would switch the app to its connect screen and a 403 shows as "UnexpectedStatus: 403".
function reject(c: Context<ProxyEnv>, message: string, detail: string) {
  console.log(`v2 guard: blocked user=${c.get("userId")} ${c.req.method} ${detail}`);
  return c.json({ _tag: "FeatureDisabled", message }, 400);
}

// GET /api/info on the dev machine, through the gateway like any proxied request.
async function defaultFetchServerInfo(c: Context<ProxyEnv>): Promise<ServerInfo> {
  const meta = c.get("session");
  const res = await fetch(upstreamUrl("http", meta.gatewayAddr, meta.id, "/api/info", ""), {
    headers: { Authorization: `Bearer ${c.get("token")}`, "X-Opencode-Directory": meta.directory },
  });
  if (!res.ok) throw new Error(`GET /api/info: ${res.status}`);
  return (await res.json()) as ServerInfo;
}

export function v2Guard(
  features: Features,
  deps: { fetchServerInfo?: (c: Context<ProxyEnv>) => Promise<ServerInfo> } = {},
): Guard {
  const fetchServerInfo = deps.fetchServerInfo ?? defaultFetchServerInfo;
  return async (c, next) => {
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (method === "OPTIONS") return next();
    const path = canonicalPath(proxyRest(c.req.path, c.req.param("sessionId")!));
    if (path === null) return reject(c, "unsupported characters in path", "undecodable path");
    const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const route = ROUTES.find((r) => r.method === method && r.re.test(trimmed));
    if (!route || route.rule === "never") {
      return reject(c, "this opencode feature is not available through opencode-rc", `${method} ${trimmed}`);
    }
    if (route.rule !== "allow" && !features[route.rule].enabled) {
      return reject(c, MESSAGES[route.rule], `${method} ${trimmed}`);
    }
    // Body and query checks for specific allowed routes (see below).
    // ...
    await next();
  };
}

export function v2Guards(config: RcConfig): Guard {
  return every(plainPath, v2Guard(config.opencodeV2.features));
}
```

Body/query checks, keyed by `route.template` (implement as small functions in the same file;
JSON bodies are read with `await c.req.raw.arrayBuffer()`, parsed, and on success stored with
`c.set("body", buffer)` so the proxy forwards the same bytes, exactly like `upload-guard.ts`;
a body that is not JSON → `reject(c, "request body is not JSON", ...)`):

- `PATCH /api/project/:projectID`: reject if the body has a `commands` key ("project commands
  cannot be changed through opencode-rc"); if uploads are disabled, reject a string
  `icon.override` starting with `data:` (case-insensitive) with the uploads message.
- `POST /api/session/:sessionID/prompt` and `POST /api/session/:sessionID/command`, only while
  uploads are disabled: reject if `body.files` is an array with any entry that is not an object
  whose `uri` is a `file:` URI.
- `POST /api/experimental/fs/write` (reached only while uploads are enabled): read the `path`
  query parameter from `new URL(c.req.url).searchParams`; reject if missing, if it contains
  `\`, a NUL, or a `..` segment, or if it does not start with `${tmp}/uploads/` where `tmp` is
  `fetchServerInfo(c).paths.tmp` (a non-empty string without a trailing `/`; strip one if
  present). Any error fetching info rejects (fail closed). Do not buffer this body (it is the
  raw upload).

- [ ] **Step 4: Run tests and commit**

```bash
cd api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
git add api/src
git commit -m "feat(api): allowlist guard for opencode 2.x sessions"
```

---

### Task 5: Choose the guard set per session

**Files:**
- Modify: `api/src/feature-guards.ts` (add `versionedGuards`, remove `featureGuards` if unused), `api/src/index.ts`
- Test: `api/src/feature-guards.test.ts` (or a new `versioned-guards.test.ts`)

**Interfaces:**
- Consumes: `v1Guards` (Task 3), `v2Guards` (Task 4), `c.get("session").opencodeVersion` (set by `sessionAccess`).
- Produces: `isV1Session(version: string | undefined): boolean`; `versionedGuards(config: RcConfig): Guard`.

- [ ] **Step 1: Failing tests**

- `isV1Session(undefined)`, `isV1Session("")`, `isV1Session("1.18.29")` → true; `isV1Session("2.0.26")`, `isV1Session("3.0.0")`, `isV1Session("garbage")` → false.
- With a session whose `opencodeVersion` is missing: `POST /proxy/s/session/x/shell` with shell disabled → 403 text (v1 set); `GET /proxy/s/session` → passes.
- With `opencodeVersion: "2.0.26"`: `GET /proxy/s/session` → 400 `FeatureDisabled` (v2 set); `GET /proxy/s/api/session` → passes.
- The 1.x toggle and the 2.x toggle are independent: `features.terminal` disabled and `opencodeV2.features.terminal` enabled → `POST /proxy/s/pty` on a 1.x session → 403, `POST /proxy/s/api/pty` on a 2.x session → passes.

- [ ] **Step 2: Implement**

```ts
// Sessions registered by CLIs that predate version reporting have no version; they ran 1.x.
export function isV1Session(version: string | undefined): boolean {
  return !version || /^1\./.test(version);
}

// The guard set for the session's opencode version (sessionAccess sets the session). The
// version comes from the gateway's record, never from the browser.
export function versionedGuards(config: RcConfig): Guard {
  const v1 = v1Guards(config);
  const v2 = v2Guards(config);
  return (c, next) => (isV1Session(c.get("session").opencodeVersion) ? v1 : v2)(c, next);
}
```

(`v2Guards` lives in `v2-guard.ts`, which imports `plainPath` from `feature-guards.ts`; to avoid
an import cycle, put `versionedGuards`/`isV1Session` in a new `api/src/guards.ts` if needed.)

In `api/src/index.ts`, replace `featureGuards(rcConfig)` with `versionedGuards(rcConfig)` (keep
the comment about running before the WebSocket relay). Update the comment at the top of
`FEATURE_GUARDS` (1.x guards) and AGENTS.md's "Adding a feature toggle" section: features are
per version (`FEATURES` + `vendor/patches/v1/` + `FEATURE_GUARDS` for 1.x; `FEATURES_V2` +
`v2-routes.ts`/`v2-guard.ts` for 2.x, UI patches in step 4).

- [ ] **Step 3: Run tests and commit**

```bash
cd api && bun run typecheck && npx -y node@22 node_modules/vitest/vitest.mjs run
cd ../ui && bun run typecheck
git add api/src AGENTS.md
git commit -m "feat(api): pick the guard set from the session's opencode version"
```

---

## After the tasks (controller)

- e2e on kind (`KUBE_CONTEXT=kind-gen1 NAMESPACE=opencode-rc-e2e-v2 ./e2e/run.sh`): 1.x behaviour
  unchanged (all suites green). 2.x is exercised in e2e from step 6.
- Report the controller ruling on `PATCH /api/experimental/config` to the user.
