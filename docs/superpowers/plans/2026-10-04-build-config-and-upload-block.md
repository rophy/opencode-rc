# Build-Time Config and Upload Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `config.json` per deployment presets the UI's server at build time, removes upload code from the UI bundle, and makes the API reject uploads.

**Architecture:** A dependency-free schema module (`config/schema.ts`) parses the file for both consumers. The UI build reads it through `OPENCODE_RC_CONFIG`, compiles `serverUrl` in (Vite `define`) and rewrites upstream opencode files with exact search/replace when uploads are off. The API reads the same file at startup and puts an upload guard in front of the proxy. The web image and chart drop the runtime `/config.json` and `API_URL`.

**Tech Stack:** TypeScript, Bun, Hono (api), SolidJS + Vite 6 (ui), vitest, helm-unittest, nginx, Skaffold/kind (e2e).

**Spec:** `docs/superpowers/specs/2026-10-04-build-config-and-upload-block-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/feat+forbid-uploads` (branch `feat/forbid-uploads`). Run every command from there.
- Package managers: **bun** in `api/`, `ui/`, `vendor/opencode`; never npm there.
- No version bumps (spec non-goal).
- No README "Upgrading to X" sections.
- Committed text must not name private hosts or internal hostnames, or reference `.local/` (see the user's local notes).
- Commit messages: `<type>: <short description>`, 1-5 lines, no attribution lines. Commits are GPG-signed automatically; never disable signing.
- Pinned upstream: opencode **v1.18.29** (`vendor/opencode`). Rewrite search strings are exact for that tag.
- Config rules (spec): every key optional; a missing feature is enabled; unknown keys at any level are errors; `serverUrl` must be `http(s)`, trailing slash stripped.
- API rejections: `403` with a short text body; a matched request whose body is not JSON: `400`.
- kubectl/skaffold always with an explicit context and namespace.

## Decisions settled in this plan

The spec left these to the plan:

- **Rewrite chokepoints.** For v1 paste, drop and the file picker, the plan neuters the one function they all call (`add()` in `prompt-input/attachments.ts`) instead of editing each handler. For the project icon, it changes the shared model (`edit-project.ts`, used by both dialogs) so dropped or picked files are ignored and clicking the icon no longer opens the picker. The hidden icon `<input>` stays in the dialog markup but nothing can open it.
- **Empty config file:** an error (not valid JSON), so a truncated file cannot silently enable everything.
- **`serverUrl` with a query or fragment:** an error; the UI appends paths to it.
- **Tests for the shared schema** live in `api/src/rc-config.test.ts`; the repo root has no test runner.
- **The API config file is only rendered by the chart when `config` is non-empty**, with a checksum annotation so a change restarts the API (it reads the file once).

## File Structure

| File | Responsibility |
| --- | --- |
| `config/schema.ts` (new) | `RcConfig` type, `parseConfig`, `parseConfigText`, `ConfigError`. No dependencies. |
| `api/src/rc-config.ts` (new) | Reads `OPENCODE_RC_CONFIG` at startup. |
| `api/src/upload-guard.ts` (new) | Middleware that rejects upload requests; buffers matched bodies. |
| `api/src/proxy.ts` | Forwards the guard's buffered body when present. |
| `api/src/index.ts` | Loads the config, wires the guard. |
| `api/Dockerfile`, `api/tsconfig.json` | Ship and type-check `config/`. |
| `ui/csp.ts` (new) | Builds the CSP string for the meta tag and the nginx header. |
| `ui/build/feature-rewrites.ts` (new) | `applyRewrites` and the Vite plugin. |
| `ui/build/upload-rewrites.ts` (new) | The rewrite table for `uploads`. |
| `ui/vite.config.ts`, `ui/vitest.config.ts` | Read the config, `define __RC_CONFIG__`, add the plugin and narrowed CSP. |
| `ui/src/build-config.ts` (new) | Exposes `__RC_CONFIG__` to `ui/src`. |
| `ui/src/server.ts`, `ui/src/entry.tsx` | Preset server from the build; no runtime `/config.json`. |
| `ui/web/security-headers.ts` (new) | Prints nginx security headers for the build's config. |
| `ui/web/Dockerfile`, `ui/web/nginx.conf`, `ui/web/smoke-test.sh` | Build-arg config, no runtime script. `ui/web/40-rc-config.sh` is deleted. |
| `charts/opencode-rc/templates/api-configmap.yaml` (new) | Renders `config` for the API. |
| `charts/opencode-rc/templates/api-deployment.yaml`, `ui-deployment.yaml`, `values.yaml` | Mount config; drop `API_URL`. |
| `e2e/rc-config.json` (new), `e2e/skaffold.yaml`, `e2e/values.yaml`, e2e tests | Build and test with uploads disabled. |
| `.github/workflows/{api,ui,ios,e2e}.yml` | Trigger on `config/**`. |
| `docs/ios-app.md`, `AGENTS.md`, `DESIGN.md`, `README.md` | Document the build-time config. |

---

### Task 0: Worktree setup

**Files:** none.

- [ ] **Step 1: Install dependencies in the worktree**

```bash
git submodule update --init --recursive
(cd vendor/opencode && bun install --frozen-lockfile)
(cd ui && bun install --frozen-lockfile)
(cd api && bun install --frozen-lockfile)
```

- [ ] **Step 2: Confirm the baseline is green**

Run: `(cd api && bun run test) && (cd ui && bun run test) && helm unittest charts/opencode-rc`
Expected: all pass (api 157, ui 107, chart 169 at the time of writing).

---

### Task 1: Shared config schema and API loader

**Files:**
- Create: `config/schema.ts`
- Create: `api/src/rc-config.ts`
- Test: `api/src/rc-config.test.ts`
- Modify: `api/tsconfig.json`, `api/Dockerfile`, `.github/workflows/api.yml`

**Interfaces:**
- Produces: `interface RcConfig { serverUrl?: string; features: { uploads: { enabled: boolean } } }`, `class ConfigError extends Error`, `parseConfig(raw: unknown, source?: string): RcConfig`, `parseConfigText(text: string, source?: string): RcConfig` (all from `config/schema.ts`); `loadRcConfig(path?: string): RcConfig` (from `api/src/rc-config.ts`, default path `process.env.OPENCODE_RC_CONFIG`).

- [ ] **Step 1: Write the failing tests**

`api/src/rc-config.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig, parseConfigText } from "../../config/schema.js";
import { loadRcConfig } from "./rc-config.js";

const ALL_ON = { features: { uploads: { enabled: true } } };

describe("parseConfig", () => {
  it("enables every feature for an empty object", () => {
    expect(parseConfig({})).toEqual(ALL_ON);
  });

  it("reads serverUrl and strips trailing slashes", () => {
    expect(parseConfig({ serverUrl: "https://rc-api.example.com//" })).toEqual({
      serverUrl: "https://rc-api.example.com",
      ...ALL_ON,
    });
  });

  it("keeps a path in serverUrl", () => {
    expect(parseConfig({ serverUrl: "http://gw.example.com/rc/" }).serverUrl).toBe("http://gw.example.com/rc");
  });

  it("disables uploads", () => {
    expect(parseConfig({ features: { uploads: { enabled: false } } })).toEqual({
      features: { uploads: { enabled: false } },
    });
  });

  it("treats a feature object without enabled as enabled", () => {
    expect(parseConfig({ features: { uploads: {} } })).toEqual(ALL_ON);
  });

  it.each([
    [{ serverURL: "https://x.example.com" }, 'unknown key "serverURL"'],
    [{ features: { upload: { enabled: false } } }, 'unknown key "features.upload"'],
    [{ features: { uploads: { enable: false } } }, 'unknown key "features.uploads.enable"'],
    [{ features: { uploads: false } }, "features.uploads must be an object"],
    [{ features: { uploads: { enabled: "no" } } }, "features.uploads.enabled must be true or false"],
    [{ features: [] }, "features must be an object"],
    [{ serverUrl: 42 }, "serverUrl must be a string"],
    [{ serverUrl: "not a url" }, "serverUrl is not a valid URL"],
    [{ serverUrl: "ftp://x.example.com" }, "serverUrl must start with http:// or https://"],
    [{ serverUrl: "https://x.example.com/?a=1" }, "serverUrl must not have a query or fragment"],
    [[], "must be a JSON object"],
    [null, "must be a JSON object"],
  ])("rejects %j", (raw, message) => {
    expect(() => parseConfig(raw, "cfg.json")).toThrow(ConfigError);
    expect(() => parseConfig(raw, "cfg.json")).toThrow(`cfg.json: ${message}`);
  });
});

describe("parseConfigText", () => {
  it("parses JSON text", () => {
    expect(parseConfigText('{"features":{"uploads":{"enabled":false}}}').features.uploads.enabled).toBe(false);
  });

  it.each(["", "{", "{} trailing"])("rejects %j as invalid JSON", (text) => {
    expect(() => parseConfigText(text, "cfg.json")).toThrow(/^cfg\.json: not valid JSON/);
  });
});

describe("loadRcConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-config-"));
  afterEach(() => {
    delete process.env.OPENCODE_RC_CONFIG;
  });

  it("enables every feature without a file", () => {
    expect(loadRcConfig(undefined)).toEqual(ALL_ON);
  });

  it("reads the file named by OPENCODE_RC_CONFIG", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, '{"serverUrl":"https://ignored.example.com","features":{"uploads":{"enabled":false}}}');
    process.env.OPENCODE_RC_CONFIG = file;
    expect(loadRcConfig().features.uploads.enabled).toBe(false);
  });

  it("fails for a missing file", () => {
    expect(() => loadRcConfig(join(dir, "nope.json"))).toThrow(/ENOENT/);
  });

  it("fails for an invalid file, naming it", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, '{"features":{"uploads":{"enabled":"off"}}}');
    expect(() => loadRcConfig(file)).toThrow(`${file}: features.uploads.enabled must be true or false`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && bun run test src/rc-config.test.ts`
Expected: FAIL, cannot resolve `../../config/schema.js`.

- [ ] **Step 3: Write `config/schema.ts`**

```ts
// The deployment config (config.json), shared by the UI build (ui/vite.config.ts) and the
// API (api/src/rc-config.ts). Keep it free of dependencies: both import it directly.

export interface RcConfig {
  /** API URL compiled into the UI. The API ignores it. */
  serverUrl?: string;
  features: {
    uploads: { enabled: boolean };
  };
}

export class ConfigError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Unknown keys are errors at every level, so a typo cannot leave a feature on.
export function parseConfig(raw: unknown, source = "config"): RcConfig {
  const fail = (message: string): never => {
    throw new ConfigError(`${source}: ${message}`);
  };
  const only = (value: Record<string, unknown>, allowed: string[], prefix: string) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(`unknown key "${prefix}${key}"`);
    }
  };
  const feature = (value: unknown, name: string): { enabled: boolean } => {
    if (value === undefined) return { enabled: true };
    if (!isObject(value)) return fail(`${name} must be an object`);
    only(value, ["enabled"], `${name}.`);
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      fail(`${name}.enabled must be true or false`);
    }
    return { enabled: value.enabled !== false };
  };

  if (!isObject(raw)) return fail("must be a JSON object");
  only(raw, ["serverUrl", "features"], "");

  let serverUrl: string | undefined;
  if (raw.serverUrl !== undefined) {
    if (typeof raw.serverUrl !== "string") return fail("serverUrl must be a string");
    let url: URL;
    try {
      url = new URL(raw.serverUrl);
    } catch {
      return fail("serverUrl is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") fail("serverUrl must start with http:// or https://");
    if (url.search || url.hash) fail("serverUrl must not have a query or fragment");
    serverUrl = raw.serverUrl.replace(/\/+$/, "");
  }

  const features = raw.features ?? {};
  if (!isObject(features)) return fail("features must be an object");
  only(features, ["uploads"], "features.");

  return {
    ...(serverUrl ? { serverUrl } : {}),
    features: { uploads: feature(features.uploads, "features.uploads") },
  };
}

export function parseConfigText(text: string, source = "config"): RcConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseConfig(raw, source);
}
```

- [ ] **Step 4: Write `api/src/rc-config.ts`**

```ts
import { readFileSync } from "node:fs";
import { parseConfig, parseConfigText, type RcConfig } from "../../config/schema.js";

// The deployment's config.json, the same file the UI is built from. The API enforces its
// feature flags and ignores serverUrl. Without a file every feature is enabled; a missing
// or invalid file stops startup.
export function loadRcConfig(path = process.env.OPENCODE_RC_CONFIG): RcConfig {
  if (!path) return parseConfig({});
  return parseConfigText(readFileSync(path, "utf8"), path);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && bun run test src/rc-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check `config/` from the API and ship it in the image**

In `api/tsconfig.json`, remove `"rootDir": "src",` and change `"include": ["src"]` to `"include": ["src", "../config"]`.

Replace `api/Dockerfile` with (the layout mirrors the repo so `../../config` resolves):

```dockerfile
FROM oven/bun:1-slim
WORKDIR /app/api
COPY api/package.json api/bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production
COPY config/ /app/config/
COPY api/src/ src/
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
```

In `.github/workflows/api.yml`, add `- 'config/**'` under both `paths:` lists (push and pull_request), next to `- 'api/**'`.

- [ ] **Step 7: Verify type-check, tests and image**

Run: `cd api && bunx tsc --noEmit -p . && bun run test`
Expected: no type errors; all tests pass.

Run: `docker build -f api/Dockerfile -t rc-api-check . && docker run --rm --entrypoint bun rc-api-check -e 'await import("/app/api/src/rc-config.ts").then(m => console.log(JSON.stringify(m.loadRcConfig())))'`
Expected: `{"features":{"uploads":{"enabled":true}}}`

- [ ] **Step 8: Commit**

```bash
git add config/schema.ts api/src/rc-config.ts api/src/rc-config.test.ts api/tsconfig.json api/Dockerfile .github/workflows/api.yml
git commit -m "feat: shared config.json schema, read by the API"
```

---

### Task 2: API upload guard

**Files:**
- Create: `api/src/upload-guard.ts`
- Test: `api/src/upload-guard.test.ts`
- Modify: `api/src/proxy.ts` (ProxyEnv, request body), `api/src/index.ts` (wiring)

**Interfaces:**
- Consumes: `loadRcConfig()` (Task 1); `proxyRest(path, sessionId)`, `ProxyEnv`, `sessionAccess`, `proxyHttp` (existing `api/src/proxy.ts`).
- Produces: `uploadGuard(enabled: boolean): MiddlewareHandler<ProxyEnv>`, `isUploadPart(part: unknown): boolean`; `ProxyEnv["Variables"]["body"]: ArrayBuffer | undefined`.

- [ ] **Step 1: Write the failing tests**

`api/src/upload-guard.test.ts`:

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import { sessionAccess, proxyHttp, type ProxyEnv } from "./proxy.js";
import { isUploadPart, uploadGuard } from "./upload-guard.js";
import type { SessionStore, SessionMeta } from "./store.js";

const meta: SessionMeta = {
  id: "alice-dev",
  userId: "alice@example.com",
  directory: "/project",
  gatewayAddr: "10.0.0.5:9090",
  createdAt: "2026-01-01T00:00:00Z",
};
const store = { get: async (id: string) => (id === meta.id ? meta : null) } as unknown as SessionStore;

function makeApp(enabled = false) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", meta.userId);
    c.set("token", "tok");
    await next();
  });
  app.all("/proxy/:sessionId/*", sessionAccess(store), uploadGuard(enabled), proxyHttp());
  return app;
}

let upstream: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const send = (method: string, path: string, body: string) =>
  makeApp().request(`/proxy/alice-dev${path}`, { method, headers: { "content-type": "application/json" }, body });

const dataPart = { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" };
const mention = { type: "file", mime: "text/plain", filename: "README.md", url: "file:///project/README.md" };
const mcp = {
  type: "file",
  mime: "text/plain",
  filename: "doc",
  url: "data:text/plain;base64,AAAA",
  source: { type: "resource", clientName: "docs", uri: "docs://a", text: { value: "", start: 0, end: 0 } },
};

describe("isUploadPart", () => {
  it.each([
    [dataPart, true],
    [{ ...dataPart, url: "https://example.com/a.png" }, true],
    [{ ...dataPart, url: undefined }, true],
    [mention, false],
    [{ ...mention, url: "FILE:///project/README.md" }, false],
    [mcp, false],
    [{ type: "text", text: "hi" }, false],
    ["file", false],
  ])("%j -> %s", (part, expected) => {
    expect(isUploadPart(part)).toBe(expected);
  });
});

describe("uploadGuard", () => {
  it.each(["message", "prompt_async", "command"])("rejects a data: part on POST /session/:id/%s", async (route) => {
    const res = await send("POST", `/session/ses_1/${route}`, JSON.stringify({ parts: [{ type: "text", text: "hi" }, dataPart] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("uploads are disabled");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects case and trailing-slash variants of the path", async () => {
    const res = await send("POST", "/Session/ses_1/Message/", JSON.stringify({ parts: [dataPart] }));
    expect(res.status).toBe(403);
  });

  it("rejects an http(s) file part", async () => {
    const res = await send("POST", "/session/ses_1/message", JSON.stringify({ parts: [{ ...dataPart, url: "https://x.example.com/a.png" }] }));
    expect(res.status).toBe(403);
  });

  it("rejects a PATCH that turns a part into an upload", async () => {
    const res = await send("PATCH", "/session/ses_1/message/msg_1/part/prt_1", JSON.stringify(dataPart));
    expect(res.status).toBe(403);
  });

  it("rejects a non-file: uri in a v2 prompt", async () => {
    const body = { prompt: { text: "hi", files: [{ uri: "file:///project/a.ts" }, { uri: "data:image/png;base64,AAAA" }] } };
    const res = await send("POST", "/api/session/ses_1/prompt", JSON.stringify(body));
    expect(res.status).toBe(403);
  });

  it("rejects a data: project icon", async () => {
    const res = await send("PATCH", "/project/prj_1", JSON.stringify({ icon: { override: "data:image/png;base64,AAAA" } }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for a matched request whose body is not JSON", async () => {
    const res = await send("POST", "/session/ses_1/message", "{not json");
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["a text prompt", "POST", "/session/ses_1/message", { parts: [{ type: "text", text: "hi" }] }],
    ["an @mention", "POST", "/session/ses_1/prompt_async", { parts: [mention] }],
    ["an MCP resource", "POST", "/session/ses_1/message", { parts: [mcp] }],
    ["a v2 prompt with workspace files", "POST", "/api/session/ses_1/prompt", { prompt: { text: "hi", files: [{ uri: "file:///project/a.ts" }] } }],
    ["a project name change", "PATCH", "/project/prj_1", { name: "x", icon: { color: "blue", override: "" } }],
  ])("forwards %s with the exact bytes", async (_name, method, path, body) => {
    const raw = ` ${JSON.stringify(body, null, 1)}\n`;
    const res = await send(method, path, raw);
    expect(res.status).toBe(204);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(raw);
  });

  it("streams unmatched requests untouched", async () => {
    const res = await send("POST", "/session", JSON.stringify({ title: "data:x" }));
    expect(res.status).toBe(204);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(ReadableStream);
  });

  it("does nothing when uploads are enabled", async () => {
    const res = await makeApp(true).request("/proxy/alice-dev/session/ses_1/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [dataPart] }),
    });
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && bun run test src/upload-guard.test.ts`
Expected: FAIL, cannot resolve `./upload-guard.js`.

- [ ] **Step 3: Write `api/src/upload-guard.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import { proxyRest, type ProxyEnv } from "./proxy.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFileUri = (value: unknown) => typeof value === "string" && value.toLowerCase().startsWith("file:");

// A file part carries uploaded bytes (data:) or a remote attachment (http(s):), unless it
// names a workspace file (file:, an @mention) or an MCP resource, which opencode reads by
// its own URI and never from the part's url.
export function isUploadPart(part: unknown): boolean {
  if (!isObject(part) || part.type !== "file") return false;
  if (isObject(part.source) && part.source.type === "resource") return false;
  return !isFileUri(part.url);
}

interface Rule {
  method: string;
  path: RegExp;
  denies: (body: unknown) => boolean;
}

// Paths are relative to /proxy/:sessionId, matched without a trailing slash and ignoring
// case so a variant opencode would also route cannot slip past.
const RULES: Rule[] = [
  {
    method: "POST",
    path: /^\/session\/[^/]+\/(message|prompt_async|command)$/i,
    denies: (body) => isObject(body) && Array.isArray(body.parts) && body.parts.some(isUploadPart),
  },
  {
    method: "PATCH",
    path: /^\/session\/[^/]+\/message\/[^/]+\/part\/[^/]+$/i,
    denies: isUploadPart,
  },
  {
    method: "POST",
    path: /^\/api\/session\/[^/]+\/prompt$/i,
    denies: (body) =>
      isObject(body) &&
      isObject(body.prompt) &&
      Array.isArray(body.prompt.files) &&
      body.prompt.files.some((file) => !isObject(file) || !isFileUri(file.uri)),
  },
  {
    method: "PATCH",
    path: /^\/project\/[^/]+$/i,
    denies: (body) =>
      isObject(body) &&
      isObject(body.icon) &&
      typeof body.icon.override === "string" &&
      body.icon.override.toLowerCase().startsWith("data:"),
  },
];

// With uploads disabled, rejects requests that would send a file to opencode. Matched
// requests are buffered and checked, and the proxy forwards those same bytes; other
// requests stream through untouched.
export function uploadGuard(enabled: boolean): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    if (enabled) return next();
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!).replace(/\/+$/, "");
    const rule = RULES.find((r) => r.method === c.req.method && r.path.test(rest));
    if (!rule) return next();

    const body = await c.req.raw.arrayBuffer();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return c.text("request body is not JSON", 400);
    }
    if (rule.denies(parsed)) {
      console.log(`upload blocked user=${c.get("userId")} ${c.req.method} ${rest}`);
      return c.text("uploads are disabled", 403);
    }
    c.set("body", body);
    await next();
  };
}
```

- [ ] **Step 4: Let the proxy forward the buffered body**

In `api/src/proxy.ts`, change the `ProxyEnv` line to:

```ts
// body: set by uploadGuard when it read the request body to check it.
export type ProxyEnv = AuthEnv & ServerEnv & { Variables: { session: SessionMeta; body: ArrayBuffer | undefined } };
```

and in `proxyHttp`, change the `body:` line of the upstream `fetch` to:

```ts
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? (c.get("body") ?? c.req.raw.body) : undefined,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && bun run test`
Expected: all pass, including `upload-guard.test.ts` and the existing `proxy.test.ts`.

- [ ] **Step 6: Wire it into the API**

In `api/src/index.ts`:

```ts
// add to the imports
import { loadRcConfig } from "./rc-config.js";
import { uploadGuard } from "./upload-guard.js";
```

After `const config = loadConfig();` add:

```ts
const rcConfig = loadRcConfig();
if (!rcConfig.features.uploads.enabled) console.log("uploads disabled");
```

Replace the proxy route with:

```ts
app.all(
  "/proxy/:sessionId/*",
  auth,
  access,
  sessionAccess(store),
  wsRelay(),
  uploadGuard(rcConfig.features.uploads.enabled),
  proxyHttp(),
);
```

- [ ] **Step 7: Type-check and run all API tests**

Run: `cd api && bunx tsc --noEmit -p . && bun run test`
Expected: no errors; all pass.

- [ ] **Step 8: Commit**

```bash
git add api/src/upload-guard.ts api/src/upload-guard.test.ts api/src/proxy.ts api/src/index.ts
git commit -m "feat: API rejects uploads when the config disables them"
```

---

### Task 3: Chart passes `config` to the API

**Files:**
- Create: `charts/opencode-rc/templates/api-configmap.yaml`
- Test: `charts/opencode-rc/tests/api_config_test.yaml` (new), `charts/opencode-rc/tests/api_deployment_test.yaml`
- Modify: `charts/opencode-rc/templates/api-deployment.yaml`, `charts/opencode-rc/values.yaml`

**Interfaces:**
- Produces: values key `config` (object, default `{}`); ConfigMap `<fullname>-api-config` with key `config.json`; API env `OPENCODE_RC_CONFIG=/etc/opencode-rc/config.json`.

- [ ] **Step 1: Write the failing tests**

`charts/opencode-rc/tests/api_config_test.yaml`:

```yaml
suite: api config
templates:
  - templates/api-configmap.yaml
tests:
  - it: is not rendered without config
    asserts:
      - hasDocuments:
          count: 0

  - it: renders config as JSON
    set:
      config:
        features:
          uploads:
            enabled: false
    asserts:
      - isKind:
          of: ConfigMap
      - equal:
          path: metadata.name
          value: RELEASE-NAME-opencode-rc-api-config
      - equal:
          path: data["config.json"]
          value: '{"features":{"uploads":{"enabled":false}}}'
```

Append to `charts/opencode-rc/tests/api_deployment_test.yaml` (under `tests:`):

```yaml
  - it: has no config file by default
    asserts:
      - notContains:
          path: spec.template.spec.containers[0].env
          content:
            name: OPENCODE_RC_CONFIG
            value: /etc/opencode-rc/config.json
      - isNull:
          path: spec.template.metadata.annotations

  - it: mounts config and restarts on change
    set:
      config:
        features:
          uploads:
            enabled: false
      api.podAnnotations:
        team: rc
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: OPENCODE_RC_CONFIG
            value: /etc/opencode-rc/config.json
      - contains:
          path: spec.template.spec.containers[0].volumeMounts
          content:
            name: config
            mountPath: /etc/opencode-rc
            readOnly: true
      - contains:
          path: spec.template.spec.volumes
          content:
            name: config
            configMap:
              name: RELEASE-NAME-opencode-rc-api-config
      - equal:
          path: spec.template.metadata.annotations.team
          value: rc
      - matchRegex:
          path: spec.template.metadata.annotations["checksum/config"]
          pattern: ^[0-9a-f]{64}$

  - it: mounts config next to extra CA certs
    set:
      config:
        features:
          uploads:
            enabled: false
      extraCACerts: |
        -----BEGIN CERTIFICATE-----
        x
        -----END CERTIFICATE-----
    asserts:
      - lengthEqual:
          path: spec.template.spec.containers[0].volumeMounts
          count: 2
      - lengthEqual:
          path: spec.template.spec.volumes
          count: 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `helm unittest -f 'tests/api_config_test.yaml' -f 'tests/api_deployment_test.yaml' charts/opencode-rc`
Expected: FAIL (template missing, env/volume assertions fail).

- [ ] **Step 3: Add the ConfigMap template**

`charts/opencode-rc/templates/api-configmap.yaml`:

```yaml
{{- if .Values.config }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "opencode-rc.fullname" . }}-api-config
  labels:
    {{- include "opencode-rc.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
data:
  config.json: {{ toJson .Values.config | quote }}
{{- end }}
```

- [ ] **Step 4: Mount it in the API deployment**

In `charts/opencode-rc/templates/api-deployment.yaml`:

Replace the pod annotations block

```yaml
      {{- with .Values.api.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

with

```yaml
      {{- if or .Values.api.podAnnotations .Values.config }}
      annotations:
        {{- with .Values.api.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
        {{- if .Values.config }}
        # The API reads its config once at startup.
        checksum/config: {{ toJson .Values.config | sha256sum }}
        {{- end }}
      {{- end }}
```

Add after the `GATEWAY_URL` env entry:

```yaml
            {{- if .Values.config }}
            - name: OPENCODE_RC_CONFIG
              value: /etc/opencode-rc/config.json
            {{- end }}
```

Replace the container `volumeMounts` block

```yaml
          {{- if .Values.extraCACerts }}
          volumeMounts:
            - name: extra-ca-certs
              mountPath: /etc/ssl/certs/extra
              readOnly: true
          {{- end }}
```

with

```yaml
          {{- if or .Values.extraCACerts .Values.config }}
          volumeMounts:
            {{- if .Values.extraCACerts }}
            - name: extra-ca-certs
              mountPath: /etc/ssl/certs/extra
              readOnly: true
            {{- end }}
            {{- if .Values.config }}
            - name: config
              mountPath: /etc/opencode-rc
              readOnly: true
            {{- end }}
          {{- end }}
```

Replace the pod `volumes` block

```yaml
      {{- if .Values.extraCACerts }}
      volumes:
        - name: extra-ca-certs
          configMap:
            name: {{ include "opencode-rc.fullname" . }}-extra-ca-certs
      {{- end }}
```

with

```yaml
      {{- if or .Values.extraCACerts .Values.config }}
      volumes:
        {{- if .Values.extraCACerts }}
        - name: extra-ca-certs
          configMap:
            name: {{ include "opencode-rc.fullname" . }}-extra-ca-certs
        {{- end }}
        {{- if .Values.config }}
        - name: config
          configMap:
            name: {{ include "opencode-rc.fullname" . }}-api-config
        {{- end }}
      {{- end }}
```

- [ ] **Step 5: Document the value**

In `charts/opencode-rc/values.yaml`, add before `# Who may list and open remote sessions.` (the `authz:` block):

```yaml
# The deployment's config.json, the same file the UI image and mobile apps are built from
# (README "Deployment Config"). The API enforces its feature flags and ignores serverUrl,
# e.g. {features: {uploads: {enabled: false}}}. Empty: every feature enabled.
config: {}

```

- [ ] **Step 6: Run all chart tests**

Run: `helm unittest charts/opencode-rc`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add charts/opencode-rc/templates/api-configmap.yaml charts/opencode-rc/templates/api-deployment.yaml charts/opencode-rc/values.yaml charts/opencode-rc/tests/api_config_test.yaml charts/opencode-rc/tests/api_deployment_test.yaml
git commit -m "feat(chart): pass config to the API"
```

---

### Task 4: UI build reads the config; server preset compiled in

**Files:**
- Create: `ui/csp.ts`, `ui/csp.test.ts`, `ui/src/build-config.ts`, `ui/src/server-preset.test.ts`
- Modify: `ui/vite.config.ts`, `ui/vitest.config.ts`, `ui/src/server.ts`, `ui/src/entry.tsx`, `ui/src/api.test.ts`, `ui/src/login-screen.test.tsx`, `.github/workflows/ui.yml`, `.github/workflows/ios.yml`

**Interfaces:**
- Consumes: `parseConfig`, `parseConfigText`, `RcConfig` (Task 1).
- Produces: `contentSecurityPolicy(serverUrl?: string, opts?: { frameAncestors?: boolean }): string` (from `ui/csp.ts`); `rcConfig: RcConfig` exported from `ui/vite.config.ts`'s helper `readBuildConfig(): RcConfig`; `buildConfig: RcConfig` (from `ui/src/build-config.ts`); in `ui/src/server.ts`: `presetServerUrl(url: string | undefined): void` (tests), `resetConfig()` now restores the build-time value, `loadConfig` removed.

- [ ] **Step 1: Write the failing CSP tests**

`ui/csp.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { contentSecurityPolicy } from "./csp"

describe("contentSecurityPolicy", () => {
  it("allows any API origin without a preset server", () => {
    expect(contentSecurityPolicy()).toContain("connect-src 'self' data: http: https: ws: wss:;")
  })

  it("narrows connect-src to the preset server's origin", () => {
    const csp = contentSecurityPolicy("https://rc-api.example.com/base")
    expect(csp).toContain("connect-src 'self' data: https://rc-api.example.com wss://rc-api.example.com;")
  })

  it("maps http to ws", () => {
    expect(contentSecurityPolicy("http://opencode-rc-api:8080")).toContain(
      "connect-src 'self' data: http://opencode-rc-api:8080 ws://opencode-rc-api:8080;",
    )
  })

  it("adds frame-ancestors only for the HTTP header", () => {
    expect(contentSecurityPolicy()).not.toContain("frame-ancestors")
    expect(contentSecurityPolicy(undefined, { frameAncestors: true })).toMatch(/; frame-ancestors 'none'$/)
  })

  it("keeps scripts limited to the bundle", () => {
    expect(contentSecurityPolicy()).toContain("script-src 'self' 'wasm-unsafe-eval';")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test csp.test.ts`
Expected: FAIL, cannot resolve `./csp`.

- [ ] **Step 3: Write `ui/csp.ts`**

```ts
// Content-Security-Policy for the UI: the meta tag in every build (what the mobile apps get)
// and the header the web image's nginx sends. With a preset server, connect-src allows only
// that origin (http(s) and its WebSocket form), so an injected script cannot send a token
// elsewhere; without one the user picks the server at runtime, so any origin is allowed.
export function contentSecurityPolicy(serverUrl?: string, opts: { frameAncestors?: boolean } = {}): string {
  let connect = "'self' data: http: https: ws: wss:"
  if (serverUrl) {
    const origin = new URL(serverUrl).origin
    connect = `'self' data: ${origin} ${origin.replace(/^http/, "ws")}`
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "media-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    // Ignored in a meta tag; only the HTTP header can set it.
    ...(opts.frameAncestors ? ["frame-ancestors 'none'"] : []),
  ].join("; ")
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && bun run test csp.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing preset test**

`ui/src/server-preset.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest"

vi.mock("./build-config", () => ({
  buildConfig: { serverUrl: "https://corp.example.com", features: { uploads: { enabled: true } } },
}))

describe("server preset from the build config", () => {
  it("uses the compiled-in serverUrl over localStorage", async () => {
    localStorage.setItem("opencode-rc-endpoint", "https://user-set.example.com")
    const { getBaseUrl, isPreConfigured } = await import("./server")
    expect(isPreConfigured()).toBe(true)
    expect(getBaseUrl()).toBe("https://corp.example.com")
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd ui && bun run test src/server-preset.test.ts`
Expected: FAIL (`isPreConfigured()` is false; `./build-config` does not exist).

- [ ] **Step 7: Add the build-time constant**

`ui/src/build-config.ts`:

```ts
import type { RcConfig } from "../../config/schema"

declare const __RC_CONFIG__: RcConfig

// The deployment config the UI was built with (OPENCODE_RC_CONFIG, see vite.config.ts).
// Tests get the default config from vitest.config.ts.
export const buildConfig: RcConfig = __RC_CONFIG__
```

In `ui/vitest.config.ts`, add the import and a `define` entry:

```ts
import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"
import { parseConfig } from "../config/schema"

export default defineConfig({
  plugins: [solid()],
  define: {
    __RC_CONFIG__: JSON.stringify(parseConfig({})),
  },
  test: {
    environment: "jsdom",
  },
})
```

- [ ] **Step 8: Take the preset from the build in `ui/src/server.ts`**

Replace the top of `ui/src/server.ts` (from `const STORAGE_KEY` through `resetConfig`) with:

```ts
import { buildConfig } from "./build-config"

const STORAGE_KEY = "opencode-rc-endpoint"

// A server compiled into the build (config.json serverUrl) wins over the one the user enters.
let preConfiguredUrl: string | undefined = buildConfig.serverUrl

export function isPreConfigured(): boolean {
  return !!preConfiguredUrl
}

// Tests only: preset a server as if it was compiled in.
export function presetServerUrl(url: string | undefined) {
  preConfiguredUrl = url?.replace(/\/+$/, "")
}

// Tests only: back to the build-time server.
export function resetConfig() {
  preConfiguredUrl = buildConfig.serverUrl
}
```

The rest of the file (`getBaseUrl` onward) stays.

In `ui/src/entry.tsx`, change the import `import { fetchMe, getBaseUrl, isPreConfigured, loadConfig } from "./api"` to `import { fetchMe, getBaseUrl, isPreConfigured } from "./api"` and the bootstrap at the end to:

```tsx
const root = document.getElementById("root")
if (root) {
  completeLogin().then((result) => render(() => <App loginExpired={result === "expired"} />, root))
}
```

- [ ] **Step 9: Update the tests that used `loadConfig`**

In `ui/src/api.test.ts`, change the import to drop `loadConfig` and add `presetServerUrl`:

```ts
import { getBaseUrl, setBaseUrl, apiUrl, isConfigured, isPreConfigured, presetServerUrl, resetConfig, fetchMe, fetchSessions } from "./api"
```

and replace the whole `describe("loadConfig / isPreConfigured", …)` block with:

```ts
describe("isPreConfigured", () => {
  it("is not pre-configured by a build without serverUrl", () => {
    expect(isPreConfigured()).toBe(false)
  })

  it("uses a preset server and strips trailing slashes", () => {
    presetServerUrl("https://corp.example.com///")
    expect(isPreConfigured()).toBe(true)
    expect(getBaseUrl()).toBe("https://corp.example.com")
  })

  it("prefers the preset server over localStorage", () => {
    setBaseUrl("https://user-set.example.com")
    presetServerUrl("https://corp.example.com")
    expect(getBaseUrl()).toBe("https://corp.example.com")
  })

  it("resetConfig goes back to the build-time server", () => {
    presetServerUrl("https://corp.example.com")
    resetConfig()
    expect(isPreConfigured()).toBe(false)
  })
})
```

In `ui/src/login-screen.test.tsx`, change `import { loadConfig, resetConfig } from "./api"` to `import { presetServerUrl, resetConfig } from "./api"`, and in the two pre-configured tests replace

```ts
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ serverUrl: "https://corp.example.com" }), { status: 200 })
    )
    await loadConfig()
```

with

```ts
    presetServerUrl("https://corp.example.com")
```

- [ ] **Step 10: Run the UI tests**

Run: `cd ui && bun run test`
Expected: all pass, including `server-preset.test.ts`. `grep -rn loadConfig ui/src` prints nothing.

- [ ] **Step 11: Read the config in `ui/vite.config.ts`**

Add to the imports:

```ts
import { parseConfig, parseConfigText, type RcConfig } from "../config/schema"
import { contentSecurityPolicy } from "./csp"
```

Add after `const ocPackages = loadOpenCodePackages()`:

```ts
// The deployment config (config.json) named by OPENCODE_RC_CONFIG, relative to ui/ or
// absolute. Unset: no preset server, every feature enabled. An invalid file fails the build.
function readBuildConfig(): RcConfig {
  const file = process.env.OPENCODE_RC_CONFIG
  if (!file) return parseConfig({})
  return parseConfigText(fs.readFileSync(path.resolve(__dirname, file), "utf8"), file)
}

const rcConfig = readBuildConfig()
```

Replace the `APP_CSP` constant and its comment, and the `cspMeta` plugin, with:

```ts
// Production builds carry a CSP meta tag, which is what the mobile apps get (the web image's
// nginx sends the same policy as a header, plus frame-ancestors).
function cspMeta(): Plugin {
  const content = contentSecurityPolicy(rcConfig.serverUrl)
  return {
    name: "csp-meta",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content }, injectTo: "head-prepend" },
    ],
  }
}
```

and add to the `defineConfig({...})` object, after `base: "/",`:

```ts
  define: {
    __RC_CONFIG__: JSON.stringify(rcConfig),
  },
```

- [ ] **Step 12: Build with and without a config**

Run:

```bash
cd ui && bun run build && grep -o "connect-src [^;]*" dist/index.html
printf '{"serverUrl":"https://rc-api.example.com/"}' > /tmp/rc-preset.json
OPENCODE_RC_CONFIG=/tmp/rc-preset.json bun run build && grep -o "connect-src [^;]*" dist/index.html && grep -l 'https://rc-api.example.com' dist/assets/*.js
printf '{"serverUrl":"ftp://x"}' > /tmp/rc-bad.json
OPENCODE_RC_CONFIG=/tmp/rc-bad.json bun run build; echo "exit=$?"
```

Expected: first build prints `connect-src 'self' data: http: https: ws: wss:`; the preset build prints `connect-src 'self' data: https://rc-api.example.com wss://rc-api.example.com` and lists one JS asset; the bad config prints `/tmp/rc-bad.json: serverUrl must start with http:// or https://` and `exit=1`.

- [ ] **Step 13: Trigger UI and iOS workflows on config changes**

In `.github/workflows/ui.yml` and `.github/workflows/ios.yml`, add `- 'config/**'` to each `paths:` list next to `- 'ui/**'`.

- [ ] **Step 14: Commit**

```bash
git add ui/csp.ts ui/csp.test.ts ui/src/build-config.ts ui/src/server-preset.test.ts ui/vite.config.ts ui/vitest.config.ts ui/src/server.ts ui/src/entry.tsx ui/src/api.test.ts ui/src/login-screen.test.tsx .github/workflows/ui.yml .github/workflows/ios.yml
git commit -m "feat(ui): compile the server and CSP from config.json at build time"
```

---

### Task 5: UI build removes uploads

**Files:**
- Create: `ui/build/feature-rewrites.ts`, `ui/build/feature-rewrites.test.ts`, `ui/build/upload-rewrites.ts`, `ui/build/upload-rewrites.test.ts`
- Modify: `ui/vite.config.ts`

**Interfaces:**
- Consumes: `rcConfig` in `ui/vite.config.ts` (Task 4); `opencodePackages` (existing in `ui/vite.config.ts`).
- Produces: `interface Rewrite { file: string; search: string; replace: string }`, `applyRewrites(code: string, file: string, rewrites: Rewrite[]): string`, `featureRewrites(packagesDir: string, rewrites: Rewrite[]): Plugin` (from `ui/build/feature-rewrites.ts`); `uploadRewrites: Rewrite[]` (from `ui/build/upload-rewrites.ts`).

- [ ] **Step 1: Write the failing plugin tests**

`ui/build/feature-rewrites.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyRewrites, featureRewrites, type Rewrite } from "./feature-rewrites"

const rewrites: Rewrite[] = [
  { file: "app/a.ts", search: "attach()\n", replace: "" },
  { file: "app/a.ts", search: "const on = true", replace: "const on = false" },
  { file: "app/b.ts", search: "other", replace: "x" },
]

describe("applyRewrites", () => {
  it("applies the rewrites of one file in order", () => {
    expect(applyRewrites("const on = true\nattach()\nend\n", "app/a.ts", rewrites)).toBe("const on = false\nend\n")
  })

  it("leaves other files alone", () => {
    expect(applyRewrites("untouched", "app/c.ts", rewrites)).toBe("untouched")
  })

  it("fails when a search text is missing", () => {
    expect(() => applyRewrites("const on = true\n", "app/a.ts", rewrites)).toThrow(
      /app\/a\.ts: expected 1 match of the rewrite text, found 0/,
    )
  })

  it("fails when a search text occurs twice", () => {
    expect(() => applyRewrites("const on = true\nattach()\nattach()\n", "app/a.ts", rewrites)).toThrow(/found 2/)
  })

  it("inserts replacement text literally", () => {
    const r: Rewrite[] = [{ file: "f.ts", search: "x", replace: "$&$1" }]
    expect(applyRewrites("x", "f.ts", r)).toBe("$&$1")
  })
})

describe("featureRewrites plugin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewrites-"))
  fs.mkdirSync(path.join(dir, "app"))
  fs.writeFileSync(path.join(dir, "app/a.ts"), "const on = true\nattach()\n")
  fs.writeFileSync(path.join(dir, "app/b.ts"), "other\n")

  it("transforms only the listed files", () => {
    const plugin = featureRewrites(dir, rewrites) as any
    expect(plugin.transform("const on = true\nattach()\n", path.join(dir, "app/a.ts?v=1"))).toEqual({
      code: "const on = false\n",
      map: null,
    })
    expect(plugin.transform("x", path.join(dir, "app/c.ts"))).toBeNull()
  })

  it("checks every file on disk at build start", () => {
    fs.writeFileSync(path.join(dir, "app/b.ts"), "changed upstream\n")
    const plugin = featureRewrites(dir, rewrites) as any
    expect(() => plugin.buildStart()).toThrow(/app\/b\.ts: expected 1 match/)
  })

  it("does nothing without rewrites", () => {
    const plugin = featureRewrites(dir, []) as any
    expect(() => plugin.buildStart()).not.toThrow()
    expect(plugin.transform("const on = true", path.join(dir, "app/a.ts"))).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test build/feature-rewrites.test.ts`
Expected: FAIL, cannot resolve `./feature-rewrites`.

- [ ] **Step 3: Write `ui/build/feature-rewrites.ts`**

```ts
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

export interface Rewrite {
  /** Relative to vendor/opencode/packages. */
  file: string
  search: string
  replace: string
}

// Each search text must occur exactly once; the replacement is inserted literally.
export function applyRewrites(code: string, file: string, rewrites: Rewrite[]): string {
  let out = code
  for (const r of rewrites) {
    if (r.file !== file) continue
    const count = out.split(r.search).length - 1
    if (count !== 1) {
      throw new Error(
        `${file}: expected 1 match of the rewrite text, found ${count}. opencode changed: update ui/build/*-rewrites.ts.\n` +
          `First line: ${r.search.split("\n")[0]}`,
      )
    }
    out = out.replace(r.search, () => r.replace)
  }
  return out
}

// Removes disabled features from upstream opencode at build time. buildStart checks every
// rewrite against the files on disk, so an opencode bump that changes or moves the code
// fails the build instead of silently bringing a feature back.
export function featureRewrites(packagesDir: string, rewrites: Rewrite[]): Plugin {
  const files = [...new Set(rewrites.map((r) => r.file))]
  return {
    name: "feature-rewrites",
    enforce: "pre",
    buildStart() {
      for (const file of files) applyRewrites(fs.readFileSync(path.join(packagesDir, file), "utf8"), file, rewrites)
    },
    transform(code, id) {
      const file = path.relative(packagesDir, id.split("?")[0])
      if (!files.includes(file)) return null
      return { code: applyRewrites(code, file, rewrites), map: null }
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && bun run test build/feature-rewrites.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test against the pinned opencode**

`ui/build/upload-rewrites.test.ts` (skipped when the submodule is not checked out, as in the UI workflow's test job; the image build still runs `buildStart`):

```ts
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyRewrites } from "./feature-rewrites"
import { uploadRewrites } from "./upload-rewrites"

const packages = fileURLToPath(new URL("../../vendor/opencode/packages", import.meta.url))
const rewritten = (file: string) =>
  applyRewrites(fs.readFileSync(path.join(packages, file), "utf8"), file, uploadRewrites)

describe.skipIf(!fs.existsSync(path.join(packages, "app")))("upload rewrites on the pinned opencode", () => {
  it("v1 composer has no file input, attach button or attach command", () => {
    const code = rewritten("app/src/components/prompt-input.tsx")
    expect(code).not.toContain('type="file"')
    expect(code).not.toContain('data-action="prompt-attach"')
    expect(code).not.toContain('id: "file.attach"')
  })

  it("v1 paste, drop and picker refuse files; @mention drops stay", () => {
    const code = rewritten("app/src/components/prompt-input/attachments.ts")
    expect(code).toContain("const add = async (file: File, toast = true, target = capture()) => {\n    return false\n")
    expect(code).not.toContain('input.setDraggingType("image")')
    expect(code).toContain('input.addPart({ type: "file", path: filePath')
  })

  it("v2 composer has no attachments config or attach command", () => {
    const code = rewritten("app/src/components/prompt-input-v2.tsx")
    expect(code).not.toContain("attachments: {")
    expect(code).not.toContain('id: "file.attach"')
  })

  it("v2 controls have no file input or attachments menu item", () => {
    const code = rewritten("session-ui/src/v2/components/prompt-input/index.tsx")
    expect(code).not.toContain('type="file"')
    expect(code).not.toContain("{props.attachLabel}")
    expect(code).toContain("<MenuV2.Item onSelect={props.onCommands}")
  })

  it("the project icon ignores files and never opens the picker", () => {
    const code = rewritten("app/src/components/edit-project.ts")
    expect(code).toContain("function selectFile(file: File) {\n    return\n")
    expect(code).not.toContain("iconInput?.click()")
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd ui && bun run test build/upload-rewrites.test.ts`
Expected: FAIL, cannot resolve `./upload-rewrites`.

- [ ] **Step 7: Write `ui/build/upload-rewrites.ts`**

The search texts below were extracted from v1.18.29 and each occurs exactly once. Copy them exactly (the long `accept=` line included).

```ts
import type { Rewrite } from "./feature-rewrites"

// Joins lines into a block that ends with a newline, so removing it removes whole lines.
const lines = (...l: string[]) => l.join("\n") + "\n"

// Rewrites that remove file uploads from opencode v1.18.29 (vendor/opencode). Paths are
// relative to vendor/opencode/packages. @mentions (file: references) keep working.
export const uploadRewrites: Rewrite[] = [
  // v1 composer: the file.attach command (mod+u)
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "    {",
      "      id: \"file.attach\",",
      "      title: language.t(\"prompt.action.attachFile\"),",
      "      category: language.t(\"command.category.file\"),",
      "      keybind: \"mod+u\",",
      "      disabled: store.mode !== \"normal\",",
      "      onSelect: pick,",
      "    },",
    ),
    replace: "",
  },
  // v1 composer: the unused hidden file input
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "  const fileAttachmentInput = () => (",
      "    <input",
      "      ref={(el) => (fileInputRef = el)}",
      "      type=\"file\"",
      "      multiple",
      "      accept={ACCEPTED_FILE_TYPES.join(\",\")}",
      "      class=\"hidden\"",
      "      onChange={(e) => {",
      "        const list = e.currentTarget.files",
      "        if (list) void addAttachments(Array.from(list))",
      "        e.currentTarget.value = \"\"",
      "      }}",
      "    />",
      "  )",
      "",
    ),
    replace: "",
  },
  // v1 composer: the hidden file input
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "            <input",
      "              ref={fileInputRef}",
      "              type=\"file\"",
      "              multiple",
      "              accept={ACCEPTED_FILE_TYPES.join(\",\")}",
      "              class=\"hidden\"",
      "              onChange={(e) => {",
      "                const list = e.currentTarget.files",
      "                if (list) void addAttachments(Array.from(list))",
      "                e.currentTarget.value = \"\"",
      "              }}",
      "            />",
      "",
    ),
    replace: "",
  },
  // v1 composer: the attach button
  {
    file: "app/src/components/prompt-input.tsx",
    search: lines(
      "              <TooltipKeybind",
      "                placement=\"top\"",
      "                title={language.t(\"prompt.action.attachFile\")}",
      "                keybind={command.keybind(\"file.attach\")}",
      "              >",
      "                <Button",
      "                  data-action=\"prompt-attach\"",
      "                  type=\"button\"",
      "                  variant=\"ghost\"",
      "                  class=\"size-8 p-0\"",
      "                  style={buttons()}",
      "                  onClick={pick}",
      "                  disabled={store.mode !== \"normal\"}",
      "                  tabIndex={store.mode === \"normal\" ? undefined : -1}",
      "                  aria-label={language.t(\"prompt.action.attachFile\")}",
      "                >",
      "                  <Icon name=\"plus\" class=\"size-4.5\" />",
      "                </Button>",
      "              </TooltipKeybind>",
    ),
    replace: "",
  },
  // v1 paste, drop and picker: every file goes through add(), which now refuses it
  {
    file: "app/src/components/prompt-input/attachments.ts",
    search: lines(
      "  const add = async (file: File, toast = true, target = capture()) => {",
      "    if (!target) return false",
    ),
    replace: lines(
      "  const add = async (file: File, toast = true, target = capture()) => {",
      "    return false",
    ),
  },
  // v1 drop: no image drop overlay for dragged files
  {
    file: "app/src/components/prompt-input/attachments.ts",
    search: lines(
      "    if (hasFiles) {",
      "      input.setDraggingType(\"image\")",
      "    } else if (hasText) {",
    ),
    replace: lines(
      "    if (hasText) {",
    ),
  },
  // v2 composer: no attachments config disables attach, paste and drop
  {
    file: "app/src/components/prompt-input-v2.tsx",
    search: lines(
      "    attachments: {",
      "      picker: platform.openAttachmentPickerDialog,",
      "      directory: () => sdk().directory,",
      "      isDialogActive: () => !!dialog.active,",
      "      warn: () =>",
      "        showToast({",
      "          title: language.t(\"prompt.toast.pasteUnsupported.title\"),",
      "          description: language.t(\"prompt.toast.pasteUnsupported.description\"),",
      "        }),",
      "      duplicate: () => showToast({ title: language.t(\"prompt.toast.attachmentDuplicate.title\") }),",
      "      onError: (error) =>",
      "        showToast({",
      "          variant: \"error\",",
      "          title: language.t(\"common.requestFailed\"),",
      "          description: error instanceof Error ? error.message : String(error),",
      "        }),",
      "      readClipboardImage: platform.readClipboardImage,",
      "      getPathForFile: platform.getPathForFile,",
      "      store: platform.draftStore?.putBlob,",
      "    },",
    ),
    replace: "",
  },
  // v2 composer: the file.attach command (mod+u)
  {
    file: "app/src/components/prompt-input-v2.tsx",
    search: lines(
      "    {",
      "      id: \"file.attach\",",
      "      title: language.t(\"prompt.action.attachFile\"),",
      "      category: language.t(\"command.category.file\"),",
      "      keybind: \"mod+u\",",
      "      disabled: controller.state.mode !== \"normal\",",
      "      onSelect: () => controller.attach(),",
      "    },",
    ),
    replace: "",
  },
  // v2 controls: the hidden file input
  {
    file: "session-ui/src/v2/components/prompt-input/index.tsx",
    search: lines(
      "      <input",
      "        ref={props.controller.setFileInput}",
      "        type=\"file\"",
      "        multiple",
      "        accept=\"image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,application/json,application/ld+json,application/toml,application/x-toml,application/x-yaml,application/xml,application/yaml,.c,.cc,.cjs,.conf,.cpp,.css,.csv,.cts,.env,.go,.gql,.graphql,.h,.hh,.hpp,.htm,.html,.ini,.java,.js,.json,.jsx,.log,.md,.mdx,.mjs,.mts,.py,.rb,.rs,.sass,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zsh\"",
      "        class=\"hidden\"",
      "        onChange={(event) => {",
      "          const list = event.currentTarget.files",
      "          if (list) props.controller.addAttachments(Array.from(list))",
      "          event.currentTarget.value = \"\"",
      "        }}",
      "      />",
    ),
    replace: "",
  },
  // v2 controls: the "Images and files" item of the + menu
  {
    file: "session-ui/src/v2/components/prompt-input/index.tsx",
    search: lines(
      "            <MenuV2.Item onSelect={props.onAttach} shortcut={props.attachShortcut}>",
      "              {props.attachLabel}",
      "            </MenuV2.Item>",
      "            <MenuV2.Separator />",
    ),
    replace: "",
  },
  // project icon (both edit dialogs): dropped or picked files are ignored
  {
    file: "app/src/components/edit-project.ts",
    search: lines(
      "  function selectFile(file: File) {",
      "    if (!file.type.startsWith(\"image/\")) return",
    ),
    replace: lines(
      "  function selectFile(file: File) {",
      "    return",
    ),
  },
  // project icon: clicking the icon no longer opens the file picker
  {
    file: "app/src/components/edit-project.ts",
    search: lines(
      "    iconInput?.click()",
    ),
    replace: "",
  },
]
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd ui && bun run test build/`
Expected: PASS (both files).

- [ ] **Step 9: Add the plugin to the build**

In `ui/vite.config.ts`, add the imports:

```ts
import { featureRewrites } from "./build/feature-rewrites"
import { uploadRewrites } from "./build/upload-rewrites"
```

and put the plugin first in `plugins` (it must see raw upstream source, before Solid):

```ts
  plugins: [
    featureRewrites(opencodePackages, rcConfig.features.uploads.enabled ? [] : uploadRewrites),
    opencodeResolver(),
    opencodeAppFonts(),
    solid(),
    tailwindcss(),
    cspMeta(),
  ],
```

- [ ] **Step 10: Build both ways and check the bundle**

Run:

```bash
cd ui && bun run build && grep -l 'application/x-toml,application/x-yaml' dist/assets/*.js
printf '{"features":{"uploads":{"enabled":false}}}' > /tmp/rc-noupload.json
OPENCODE_RC_CONFIG=/tmp/rc-noupload.json bun run build && grep -l 'application/x-toml,application/x-yaml' dist/assets/*.js; echo "matches=$?"
```

Expected: the default build lists the asset that holds the v2 file input's `accept` list; the uploads-disabled build succeeds and finds none (`matches=1`).

- [ ] **Step 11: Run all UI tests**

Run: `cd ui && bun run test`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add ui/build ui/vite.config.ts
git commit -m "feat(ui): remove uploads from the bundle when config.json disables them"
```

---

### Task 6: Web image built from the config; chart drops `API_URL`

**Files:**
- Create: `ui/web/security-headers.ts`
- Delete: `ui/web/40-rc-config.sh`
- Modify: `ui/web/Dockerfile`, `ui/web/nginx.conf`, `ui/web/smoke-test.sh`, `charts/opencode-rc/templates/ui-deployment.yaml`, `charts/opencode-rc/tests/ui_deployment_test.yaml`

**Interfaces:**
- Consumes: `contentSecurityPolicy` (Task 4), `parseConfig`/`parseConfigText` (Task 1).
- Produces: Docker build arg `RC_CONFIG` (path of a config.json inside the build context; empty = generic image); `/etc/nginx/rc/security-headers.conf` in the image.

- [ ] **Step 1: Write the header generator**

`ui/web/security-headers.ts`:

```ts
// Prints the nginx security headers for the web image, from the same config the bundle was
// built with (OPENCODE_RC_CONFIG). Run by ui/web/Dockerfile: bun run web/security-headers.ts
import fs from "node:fs"
import { parseConfig, parseConfigText } from "../../config/schema"
import { contentSecurityPolicy } from "../csp"

const file = process.env.OPENCODE_RC_CONFIG
const config = file ? parseConfigText(fs.readFileSync(file, "utf8"), file) : parseConfig({})
const csp = contentSecurityPolicy(config.serverUrl, { frameAncestors: true })

process.stdout.write(
  [
    `add_header Content-Security-Policy "${csp}" always;`,
    `add_header X-Content-Type-Options "nosniff" always;`,
    `add_header Referrer-Policy "no-referrer" always;`,
    "",
  ].join("\n"),
)
```

Check it: `cd ui && bun run web/security-headers.ts && OPENCODE_RC_CONFIG=/tmp/rc-preset.json bun run web/security-headers.ts`
Expected: three `add_header` lines; the first with `connect-src 'self' data: http: https: ws: wss:; …; frame-ancestors 'none'`, the second with `connect-src 'self' data: https://rc-api.example.com wss://rc-api.example.com`.

- [ ] **Step 2: Rewrite the Dockerfile**

`ui/web/Dockerfile`:

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /src
COPY vendor/opencode/package.json vendor/opencode/bun.lock vendor/opencode/
COPY vendor/opencode/patches/ vendor/opencode/patches/
COPY vendor/opencode/packages/ vendor/opencode/packages/
RUN cd vendor/opencode && bun install --frozen-lockfile --ignore-scripts
COPY ui/package.json ui/bun.lock ui/
RUN cd ui && bun install --frozen-lockfile
COPY config/ config/
COPY ui/ ui/
# Path of the deployment's config.json inside the build context (e.g. --build-arg
# RC_CONFIG=deploy/config.json). Empty builds the generic image: users enter the server.
ARG RC_CONFIG=""
RUN --mount=type=bind,target=/ctx \
    if [ -n "$RC_CONFIG" ]; then cp "/ctx/$RC_CONFIG" /src/rc-config.json; fi
RUN cd ui \
    && if [ -f /src/rc-config.json ]; then export OPENCODE_RC_CONFIG=/src/rc-config.json; fi \
    && OPENCODE_ROOT=/src/vendor/opencode bun run build \
    && bun run web/security-headers.ts > /src/security-headers.conf

FROM nginxinc/nginx-unprivileged:alpine
COPY ui/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/security-headers.conf /etc/nginx/rc/security-headers.conf
COPY --from=build /src/ui/dist /usr/share/nginx/html
EXPOSE 8080
```

Delete the runtime script: `git rm ui/web/40-rc-config.sh`

- [ ] **Step 3: Update nginx.conf**

In `ui/web/nginx.conf`, delete the whole `location = /config.json { … }` block, and change every `include /tmp/rc-config/security-headers.conf;` to `include /etc/nginx/rc/security-headers.conf;`.

- [ ] **Step 4: Update the smoke test for the generic image**

In `ui/web/smoke-test.sh`:

- Change the header comment to `# Starts the UI image and checks routing, caching and security headers.`
- Delete the `expect_start_failure` function and its two calls.
- Change the `docker run -d …` line to: `docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null`
- Replace the two `/config.json` checks with:

```sh
# No runtime config: the generic image's SPA fallback answers /config.json with index.html.
curl -s "$B/config.json" | grep -q '<div id="root"' || fail "/config.json should not be served"
```

- Replace the `connect-src` check with:

```sh
echo "$CSP" | grep -q "connect-src 'self' data: http: https: ws: wss:;" || fail "CSP connect-src: $CSP"
```

- [ ] **Step 5: Build and smoke-test both image variants**

Run:

```bash
docker build -f ui/web/Dockerfile -t rc-ui-generic . && ui/web/smoke-test.sh rc-ui-generic
cp /tmp/rc-preset.json ui/web/.rc-preset.json
docker build -f ui/web/Dockerfile --build-arg RC_CONFIG=ui/web/.rc-preset.json -t rc-ui-preset .
rm ui/web/.rc-preset.json
docker run -d --rm --name rc-ui-preset -p 127.0.0.1:18090:8080 rc-ui-preset && sleep 2
curl -sI http://127.0.0.1:18090/ | grep -i content-security-policy; docker rm -f rc-ui-preset
```

Expected: `UI image smoke test passed`; the preset image's header contains `connect-src 'self' data: https://rc-api.example.com wss://rc-api.example.com;` and `frame-ancestors 'none'`.

- [ ] **Step 6: Drop `API_URL` from the chart (failing test first)**

In `charts/opencode-rc/tests/ui_deployment_test.yaml`, replace the first test's `contains` assertion on `API_URL` with:

```yaml
      - isNull:
          path: spec.template.spec.containers[0].env
```

rename that test to `renders the ui deployment`, and delete the tests `uses the exposed api URL`, `honours expose.scheme http for the api URL` and `uses api.publicUrl for API_URL, trimming a trailing slash`.

Run: `helm unittest -f tests/ui_deployment_test.yaml charts/opencode-rc`
Expected: FAIL (env is still set).

In `charts/opencode-rc/templates/ui-deployment.yaml`, delete:

```yaml
          env:
            - name: API_URL
              value: {{ include "opencode-rc.apiPublicUrl" . | quote }}
```

and change the comment `# The config script and nginx write here; keeps readOnlyRootFilesystem working.` to `# nginx writes here; keeps readOnlyRootFilesystem working.`

Run: `helm unittest charts/opencode-rc`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add ui/web charts/opencode-rc/templates/ui-deployment.yaml charts/opencode-rc/tests/ui_deployment_test.yaml
git commit -m "feat(ui): web image takes config.json at build time, no runtime API_URL"
```

---

### Task 7: e2e builds and tests with uploads disabled

**Files:**
- Create: `e2e/rc-config.json`
- Modify: `e2e/skaffold.yaml`, `e2e/values.yaml`, `e2e/e2e.test.ts`, `e2e/playwright/web-ui.spec.ts`, `.github/workflows/e2e.yml`

**Interfaces:**
- Consumes: `RC_CONFIG` build arg (Task 6); chart `config` (Task 3); guard responses (Task 2: `403 uploads are disabled`).

- [ ] **Step 1: Configure the e2e build and release**

`e2e/rc-config.json`:

```json
{
  "serverUrl": "http://opencode-rc-api:8080",
  "features": {
    "uploads": { "enabled": false }
  }
}
```

In `e2e/skaffold.yaml`, give the `opencode-rc-ui` artifact a build arg (context is the repo root):

```yaml
    - image: opencode-rc-ui
      context: ..
      docker:
        dockerfile: ui/web/Dockerfile
        buildArgs:
          RC_CONFIG: e2e/rc-config.json
```

Append to `e2e/values.yaml`:

```yaml
# Same features as e2e/rc-config.json, which the UI image is built from.
config:
  features:
    uploads:
      enabled: false
```

In `.github/workflows/e2e.yml`, add `- 'config/**'` to both `paths:` lists.

- [ ] **Step 2: Replace the runtime config test and add guard tests**

In `e2e/e2e.test.ts`, replace the test `the UI is configured with the API URL` with:

```ts
  it("the UI is built for the API URL", async () => {
    const res = await fetch(`${UI_URL}/`);
    expect(res.headers.get("content-security-policy")).toContain(
      `connect-src 'self' data: ${API_URL} ${API_URL.replace(/^http/, "ws")};`,
    );
    expect((await fetch(`${UI_URL}/config.json`)).headers.get("content-type")).toContain("text/html");
  });
```

Append a new `describe` block at the end of the file:

```ts
describe("uploads disabled", () => {
  let jar: TokenSession;
  let sessionID: string;
  const proxy = (path: string) => `${API_URL}/proxy/${SESSION_ID}${path}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const upload = { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,iVBORw0KGgo=" };

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
    const res = await jar.fetch(proxy("/session"), json("POST", {}));
    expect(res.status).toBe(200);
    sessionID = (await res.json()).id;
  });

  it("rejects a prompt with an uploaded file", async () => {
    const res = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json("POST", { parts: [upload] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("uploads are disabled");
  });

  it("rejects a v2 prompt with an uploaded file", async () => {
    const body = { prompt: { text: "hi", files: [{ uri: upload.url }] } };
    const res = await jar.fetch(proxy(`/api/session/${sessionID}/prompt`), json("POST", body));
    expect(res.status).toBe(403);
  });

  it("rejects an uploaded project icon", async () => {
    const res = await jar.fetch(proxy("/project/any"), json("PATCH", { icon: { override: upload.url } }));
    expect(res.status).toBe(403);
  });

  it("still accepts a text prompt and an @mention", async () => {
    const text = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json("POST", { parts: [{ type: "text", text: "hi" }] }));
    expect(text.status).toBe(204);
    const mention = { type: "file", mime: "text/plain", filename: "a.txt", url: "file:///project/a.txt" };
    const res = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json("POST", { parts: [mention] }));
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 3: Check that the UI has no attach entry**

Append to `e2e/playwright/web-ui.spec.ts`:

```ts
test.describe("uploads disabled", () => {
  test("the composer's + menu has no attachments item", async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, "Alice");
    await page.locator("a[href*='/s/alice-dev/']").first().click();
    // Same steps as the golden path: "New session" is a no-op until the project is listed.
    await page.locator('[data-component="home-project-row"]').first().waitFor({ state: "visible", timeout: 30_000 });
    const tabs = page.locator('[data-slot="titlebar-tab-item"]');
    const before = await tabs.count();
    await page.locator('button[aria-label="New session"]').first().click();
    await expect(tabs).toHaveCount(before + 1, { timeout: 30_000 });
    await tabs.last().locator('[data-slot="tab-link"]').click();
    await expect(page.locator('[data-component="prompt-input"]')).toBeVisible({ timeout: 30_000 });

    // The v2 composer (the default layout): its + menu keeps commands, context and shell.
    await page.locator('[data-action="prompt-attach"]').click();
    await expect(page.getByRole("menuitem", { name: "Commands" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Images and files" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });
});
```

- [ ] **Step 4: Run the e2e suite**

Run (explicit context and a dedicated namespace; deleted afterwards):

```bash
KUBE_CONTEXT=<kind context> NAMESPACE=opencode-rc-e2e ./e2e/run.sh
```

Expected: vitest and Playwright all pass, including the new tests.

- [ ] **Step 5: Commit**

```bash
git add e2e/rc-config.json e2e/skaffold.yaml e2e/values.yaml e2e/e2e.test.ts e2e/playwright/web-ui.spec.ts .github/workflows/e2e.yml
git commit -m "test(e2e): build the UI from config.json and check that uploads are blocked"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/ios-app.md`, `AGENTS.md`, `DESIGN.md`, `README.md`

- [ ] **Step 1: `docs/ios-app.md`**

Replace the section `## Build-Time config.json` (heading through "Users then never see the server settings screen.") with:

````markdown
## Build-Time Config

The deployment's `config.json` presets the server and switches features off. Name it when
building the UI:

```bash
cd ui
OPENCODE_RC_CONFIG=/path/to/config.json bun run build
```

```json
{
  "serverUrl": "https://rc.corp.example.com",
  "features": { "uploads": { "enabled": false } }
}
```

With `serverUrl` set, users never see the server settings screen and the app may only
connect to that origin. A disabled feature is removed from the app; the API enforces the
same file (chart value `config`).
````

In `## Distribution`, replace step 2 with:

```markdown
2. The `releases/ios` build is generic: users enter the server. To preset the server or
   disable features, build from source instead (see "Building Locally").
```

In `## Building Locally`, replace the block with:

```bash
cd ui
OPENCODE_RC_CONFIG=/path/to/config.json bun run build   # optional: preset server, features
npx cap sync ios
open ios/App/App.xcodeproj
```

- [ ] **Step 2: `AGENTS.md`**

Replace

```markdown
`com.opencode.rc:/auth/done`) and their WebView loads only the bundled app. To preset the server,
write `dist/config.json` (`{"serverUrl": …}`) before `npx cap sync` (see `docs/ios-app.md`).
```

with

```markdown
`com.opencode.rc:/auth/done`) and their WebView loads only the bundled app. To preset the server
or disable features, build with `OPENCODE_RC_CONFIG=/path/to/config.json bun run build`
(schema: `config/schema.ts`; see `docs/ios-app.md`).
```

and in the project structure block change `ui/web/         # nginx image packaging for ui/dist (Dockerfile, nginx.conf, runtime config)` to `ui/web/         # nginx image packaging for ui/dist (Dockerfile, nginx.conf)` and add a line `config/         # config.json schema shared by the UI build and the API`.

- [ ] **Step 3: `DESIGN.md`**

Replace the two bullets at lines 68-69 (`Writes /config.json …`, `The SPA reads /config.json …`) with:

```markdown
- Built from the deployment's `config.json` (`--build-arg RC_CONFIG=…`): the API URL is compiled in; the generic image asks the user
- The SPA calls the API cross-origin using bearer auth
```

and in the **UI host** paragraph (line 85) replace `serves the built SPA (session picker + OpenCode web UI) and `/config.json`, which tells the SPA the API URL. It has no API routes.` with `serves the built SPA (session picker + OpenCode web UI). It has no API routes.`

- [ ] **Step 4: `README.md`**

Add after the `### Access Control` section (before `### Air-Gapped Environments`):

````markdown
### Deployment Config

One `config.json` per deployment presets the UI's server and switches features off:

```json
{
  "serverUrl": "https://api.rc.example.com",
  "features": { "uploads": { "enabled": false } }
}
```

Every key is optional and unknown keys are errors. `features.uploads.enabled: false` removes
image and file attachments from the UI (pasted, dropped or picked files and project icons)
and makes the API reject them with `403`. `@` references to workspace files keep working;
pasting into the terminal is not covered.

- **UI**: the published `ui` image is generic and asks users for the server. Build your own
  with `docker build -f ui/web/Dockerfile --build-arg RC_CONFIG=path/to/config.json .` and set
  `ui.image`; for mobile apps see `docs/ios-app.md`.
- **API**: set the chart value `config` to the same content (the API ignores `serverUrl`).
````

- [ ] **Step 5: Check for stale references**

Run: `grep -rn -E '40-rc-config|API_URL|/config\.json' --include=*.md --include=*.yaml --include=*.ts --include=*.tsx --include=*.sh --include=Dockerfile . | grep -v -E 'node_modules|vendor/|docs/superpowers|e2e/k8s/dev-machine.yaml|\.github/workflows/e2e.yml|Makefile'`
Expected: only the `/config.json` checks in `e2e/e2e.test.ts` and `ui/web/smoke-test.sh`. (`API_URL` in the Makefile and e2e workflow is the test runner's variable, not the UI's.)

- [ ] **Step 6: Commit**

```bash
git add docs/ios-app.md AGENTS.md DESIGN.md README.md
git commit -m "docs: build-time config.json and the uploads feature flag"
```

---

### Task 9: Final verification

- [ ] **Step 1: Unit tests and type-checks**

Run: `make unit-test && (cd api && bunx tsc --noEmit -p .)`
Expected: all pass.

- [ ] **Step 2: Private names and local paths**

Run: `git diff main --stat && git diff main | grep -n -iE '\.local/|LOCAL\.md' || echo clean`
Expected: `clean`. Also check the diff for private hostnames listed in your local notes.

- [ ] **Step 3: Report**

Summarize for the user: commits, test results (unit, smoke, e2e), and the upgrade impact from the spec (chart users relying on `API_URL` get a UI that asks for the server URL until they build their own image). Do not push.
