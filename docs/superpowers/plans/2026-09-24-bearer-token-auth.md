# Bearer Token Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `orc_session` cookie with bearer tokens (15-min access + rotating refresh) so the browser UI and the Capacitor app use the same auth path, the app stops using CapacitorHttp, and the terminal WebSocket works through web.

**Architecture:** web issues HMAC access tokens and Redis-backed refresh tokens after OIDC; the UI keeps the access token in memory and the refresh token in `localStorage`. OpenCode API traffic moves from `/s/:id/*` to `/proxy/:id/*` (HTTP, SSE and WebSocket, bearer-authenticated); `/s/:id/...` becomes a plain SPA route. The gateway verifies the same access token instead of the cookie.

**Tech Stack:** web: Bun + Hono 4.13 + ioredis, tests with vitest (Node). gateway: Go 1.x, `net/http`, gorilla/websocket, tests with `go test` (testcontainers Redis). ui: SolidJS + Vite, tests with vitest + jsdom. Helm chart with helm-unittest. e2e: kind + Skaffold, vitest + Playwright inside the dev-machine pod.

**Spec:** `docs/superpowers/specs/2026-09-24-bearer-token-auth-design.md`

## Global Constraints

- Access token: `typ: "access"`, TTL `15m` default (`ACCESS_TOKEN_TTL`), HMAC-SHA256, format `base64url(json) + "." + base64url(mac)`.
- Session (refresh chain) TTL: `7d` absolute (`SESSION_TTL`), never extended by refresh.
- Refresh reuse grace window: 30 seconds.
- Login code TTL: 60 seconds, single use.
- Secret env: `TOKEN_SECRET`, falling back to `COOKIE_SECRET`; 64-char hex (32 bytes).
- App origins always allowed: `capacitor://localhost`, `https://localhost`. Extra origins from `ALLOWED_ORIGINS` (comma-separated).
- Redis key prefix `orc:` (matches existing `orc:session:*`).
- Refresh token `localStorage` key: `opencode-rc-refresh`.
- Error bodies: `{"error":"unauthorized"}` (401), `{"error":"invalid_grant"}` (400 for codes, 401 for refresh), `{"error":"unavailable"}` (503).
- Package managers: `web/` and `ui/` use **bun**; never run npm install there.
- Commit messages: `<type>: <description>`, no attribution lines, no mention of Claude.
- Run unit tests with `make unit-test` from the repo root before the final push.
- kubectl context for e2e: `kind-opencode-rc-e2e` (created by `make up`).

---

## File Map

**web/**
- Create `src/token.ts`: access-token sign/verify, random tokens, hashing. Replaces `src/cookie.ts`.
- Create `src/token-store.ts`: login codes, refresh chains, rotation, revocation (Redis).
- Create `src/origins.ts`: allowed-origin check, `return_to` validation, CORS middleware.
- Create `src/testing/mock-redis.ts`: in-memory Redis subset for unit tests.
- Rewrite `src/auth.ts`: bearer middleware and `/auth/*` routes.
- Rewrite `src/proxy.ts`: `/proxy/:id/*` session access check, HTTP forwarding, upstream URL builder.
- Create `src/ws-relay.ts`: WebSocket relay to the gateway.
- Rewrite `src/webui.ts`: SPA file resolution and serving.
- Modify `src/config.ts`, `src/index.ts`.
- Delete `src/cookie.ts`, `src/cookie.test.ts`.

**gateway/**
- Create `token.go`, `token_test.go`: access-token verification and bearer extraction. Replaces `cookie.go`.
- Modify `gateway_proxy.go`, `gateway_proxy_test.go`, `config.go`, `config_test.go`, `main.go`, `main_test.go`, `routes_gateway.go`.

**charts/opencode-rc/**
- Modify `values.yaml`, `templates/secret.yaml`, `templates/web-deployment.yaml`, `templates/gateway-deployment.yaml`, `tests/web_deployment_test.yaml`, `tests/gateway_deployment_test.yaml`, `tests/secret_test.yaml`.

**ui/**
- Create `src/server.ts`: server URL config (moved out of `api.ts`).
- Create `src/auth.ts`, `src/auth.test.ts`: token handling.
- Create `src/proxy-fetch.ts`, `src/proxy-fetch.test.ts`: fetch/WebSocket rewriting to `/proxy/:id`.
- Modify `src/api.ts`, `src/login-screen.tsx`, `src/user-bar.tsx`, `src/entry.tsx`, `capacitor.config.ts`, `vite.config.ts`.
- Delete `src/fix-response.ts`, `src/fix-response.test.ts`.

**e2e/**
- Modify `e2e.test.ts`, `playwright/web-ui.spec.ts`, `playwright/golden-path.spec.ts`.

---

### Task 1: web access tokens (`token.ts`)

**Files:**
- Create: `web/src/token.ts`
- Test: `web/src/token.test.ts`

**Interfaces:**
- Produces:
  - `interface AccessClaims { uid: string; email: string; name: string }`
  - `signAccessToken(claims: AccessClaims, secret: Uint8Array, ttlSeconds: number, now?: number): string`
  - `verifyAccessToken(token: string, secret: Uint8Array, now?: number): AccessClaims | null`
  - `randomToken(bytes?: number): string` (base64url)
  - `hashToken(token: string): string` (sha256 hex)

- [ ] **Step 1: Write the failing test**

`web/src/token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signAccessToken, verifyAccessToken, randomToken, hashToken } from "./token.js";
import { createHmac } from "node:crypto";

const secret = new Uint8Array(32).fill(0xab);
const claims = { uid: "alice@example.com", email: "alice@example.com", name: "Alice" };

describe("access tokens", () => {
  it("round-trips claims", () => {
    const token = signAccessToken(claims, secret, 900);
    expect(verifyAccessToken(token, secret)).toEqual(claims);
  });

  it("rejects an expired token", () => {
    const t0 = Date.now();
    const token = signAccessToken(claims, secret, 900, t0);
    expect(verifyAccessToken(token, secret, t0 + 899_000)).toEqual(claims);
    expect(verifyAccessToken(token, secret, t0 + 900_000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signAccessToken(claims, secret, 900);
    expect(verifyAccessToken("x" + token.slice(1), secret)).toBeNull();
  });

  it("rejects a different secret", () => {
    const token = signAccessToken(claims, secret, 900);
    expect(verifyAccessToken(token, new Uint8Array(32).fill(0xcd))).toBeNull();
  });

  it("rejects a correctly signed payload without typ=access", () => {
    const payload = Buffer.from(
      JSON.stringify({ uid: "alice", email: "", name: "", exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString("base64url");
    const mac = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(verifyAccessToken(`${payload}.${mac}`, secret)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyAccessToken("", secret)).toBeNull();
    expect(verifyAccessToken("abc", secret)).toBeNull();
    expect(verifyAccessToken("a.b.c", secret)).toBeNull();
  });
});

describe("randomToken / hashToken", () => {
  it("produces distinct url-safe tokens", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically to hex", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/token.test.ts`
Expected: FAIL, cannot resolve `./token.js`.

- [ ] **Step 3: Write the implementation**

`web/src/token.ts`:

```ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface AccessClaims {
  uid: string;
  email: string;
  name: string;
}

interface AccessPayload extends AccessClaims {
  typ: "access";
  exp: number;
}

function mac(payload: string, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signAccessToken(
  claims: AccessClaims,
  secret: Uint8Array,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const body: AccessPayload = {
    typ: "access",
    uid: claims.uid,
    email: claims.email,
    name: claims.name,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

export function verifyAccessToken(
  token: string,
  secret: Uint8Array,
  now = Date.now(),
): AccessClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(payload, secret));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let body: Partial<AccessPayload>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (body.typ !== "access" || typeof body.exp !== "number" || typeof body.uid !== "string") {
    return null;
  }
  if (Math.floor(now / 1000) >= body.exp) return null;
  return { uid: body.uid, email: body.email ?? "", name: body.name ?? "" };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/token.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/token.ts web/src/token.test.ts
git commit -m "feat(web): add HMAC access token helpers"
```

---

### Task 2: web refresh-token store (`token-store.ts`)

**Files:**
- Create: `web/src/testing/mock-redis.ts`
- Create: `web/src/token-store.ts`
- Test: `web/src/token-store.test.ts`

**Interfaces:**
- Consumes: `AccessClaims`, `randomToken`, `hashToken` from Task 1.
- Produces:
  - `interface RedisLike { get(key: string): Promise<string | null>; getdel(key: string): Promise<string | null>; set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>; del(...keys: string[]): Promise<number>; ttl(key: string): Promise<number> }`
  - `type RotateResult = { ok: true; refreshToken: string; claims: AccessClaims } | { ok: false }`
  - `class TokenStore { constructor(redis: RedisLike, sessionTtlSeconds: number, codeTtlSeconds?: number); createCode(claims): Promise<string>; consumeCode(code): Promise<AccessClaims | null>; createChain(claims): Promise<string>; rotate(refreshToken): Promise<RotateResult>; revoke(refreshToken): Promise<void> }`
  - `class MockRedis implements RedisLike` with `advance(seconds: number): void` for tests.
  - `const REFRESH_GRACE_SECONDS = 30`

**Redis keys:**

| Key | Value | TTL |
|---|---|---|
| `orc:code:<code>` | claims JSON | 60 s |
| `orc:chain:<id>` | uid | session TTL (absolute) |
| `orc:rt:<sha256>` | `{chain, uid, email, name}` | remaining chain TTL |
| `orc:rtused:<sha256>` | `"1"` (token was rotated) | remaining chain TTL |
| `orc:rtgrace:<sha256>` | the refresh token it was rotated to | 30 s |

**Rotation algorithm** (`rotate(token)`, `h = sha256(token)`):
1. `rt:<h>` missing → `{ok:false}`. `ttl(chain:<id>) <= 0` → `{ok:false}`.
2. `rtused:<h>` exists → if `rtgrace:<h>` exists return it; otherwise delete `chain:<id>` (reuse after grace = theft) and return `{ok:false}`.
3. Otherwise generate `next`; `SET rtgrace:<h> next EX 30 NX`. If it succeeded: store `rt:<sha256(next)>` and `rtused:<h>` with the chain's remaining TTL, return `next`. If it failed (another request rotated concurrently): return `GET rtgrace:<h>`, or `{ok:false}` if that is empty.

- [ ] **Step 1: Write the mock Redis**

`web/src/testing/mock-redis.ts`:

```ts
import type { RedisLike } from "../token-store.js";

interface Entry {
  value: string;
  expiresAt: number | null; // seconds on the mock clock
}

// In-memory subset of Redis used by TokenStore, with a manual clock.
export class MockRedis implements RedisLike {
  private data = new Map<string, Entry>();
  private now = 0;

  advance(seconds: number): void {
    this.now += seconds;
  }

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async getdel(key: string): Promise<string | null> {
    const v = this.live(key)?.value ?? null;
    this.data.delete(key);
    return v;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    let ex: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === "EX") ex = Number(args[++i]);
      else if (a === "NX") nx = true;
    }
    if (nx && this.live(key)) return null;
    this.data.set(key, { value, expiresAt: ex === null ? null : this.now + ex });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    return n;
  }

  async ttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return e.expiresAt - this.now;
  }
}
```

- [ ] **Step 2: Write the failing test**

`web/src/token-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { TokenStore, REFRESH_GRACE_SECONDS } from "./token-store.js";
import { MockRedis } from "./testing/mock-redis.js";

const claims = { uid: "alice@example.com", email: "alice@example.com", name: "Alice" };
const WEEK = 7 * 24 * 3600;

let redis: MockRedis;
let store: TokenStore;

beforeEach(() => {
  redis = new MockRedis();
  store = new TokenStore(redis, WEEK);
});

describe("login codes", () => {
  it("can be consumed once", async () => {
    const code = await store.createCode(claims);
    expect(await store.consumeCode(code)).toEqual(claims);
    expect(await store.consumeCode(code)).toBeNull();
  });

  it("expire after 60 seconds", async () => {
    const code = await store.createCode(claims);
    redis.advance(60);
    expect(await store.consumeCode(code)).toBeNull();
  });
});

describe("refresh rotation", () => {
  it("rotates to a new token with the same claims", async () => {
    const t1 = await store.createChain(claims);
    const r = await store.rotate(t1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refreshToken).not.toBe(t1);
    expect(r.claims).toEqual(claims);
    const r2 = await store.rotate(r.refreshToken);
    expect(r2.ok).toBe(true);
  });

  it("returns the same next token when reused within the grace window", async () => {
    const t1 = await store.createChain(claims);
    const a = await store.rotate(t1);
    redis.advance(REFRESH_GRACE_SECONDS - 1);
    const b = await store.rotate(t1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.refreshToken).toBe(a.refreshToken);
  });

  it("revokes the chain when reused after the grace window", async () => {
    const t1 = await store.createChain(claims);
    const a = await store.rotate(t1);
    redis.advance(REFRESH_GRACE_SECONDS);
    expect((await store.rotate(t1)).ok).toBe(false);
    if (!a.ok) return;
    // the legitimate successor is dead too
    expect((await store.rotate(a.refreshToken)).ok).toBe(false);
  });

  it("stops working at the absolute session expiry", async () => {
    let t = await store.createChain(claims);
    for (let i = 0; i < 6; i++) {
      redis.advance(24 * 3600);
      const r = await store.rotate(t);
      expect(r.ok).toBe(true);
      if (r.ok) t = r.refreshToken;
    }
    redis.advance(24 * 3600);
    expect((await store.rotate(t)).ok).toBe(false);
  });

  it("rejects unknown tokens", async () => {
    expect((await store.rotate("nope")).ok).toBe(false);
  });

  it("revoke ends the chain", async () => {
    const t1 = await store.createChain(claims);
    await store.revoke(t1);
    expect((await store.rotate(t1)).ok).toBe(false);
  });

  it("revoke of an unknown token is a no-op", async () => {
    await expect(store.revoke("nope")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/token-store.test.ts`
Expected: FAIL, cannot resolve `./token-store.js`.

- [ ] **Step 4: Write the implementation**

`web/src/token-store.ts`:

```ts
import { hashToken, randomToken, type AccessClaims } from "./token.js";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
}

export type RotateResult =
  | { ok: true; refreshToken: string; claims: AccessClaims }
  | { ok: false };

export const REFRESH_GRACE_SECONDS = 30;

interface RefreshRecord extends AccessClaims {
  chain: string;
}

const key = {
  code: (code: string) => `orc:code:${code}`,
  chain: (id: string) => `orc:chain:${id}`,
  rt: (hash: string) => `orc:rt:${hash}`,
  used: (hash: string) => `orc:rtused:${hash}`,
  grace: (hash: string) => `orc:rtgrace:${hash}`,
};

export class TokenStore {
  constructor(
    private redis: RedisLike,
    private sessionTtlSeconds: number,
    private codeTtlSeconds = 60,
  ) {}

  async createCode(claims: AccessClaims): Promise<string> {
    const code = randomToken();
    await this.redis.set(key.code(code), JSON.stringify(claims), "EX", this.codeTtlSeconds);
    return code;
  }

  async consumeCode(code: string): Promise<AccessClaims | null> {
    const raw = await this.redis.getdel(key.code(code));
    return raw ? (JSON.parse(raw) as AccessClaims) : null;
  }

  async createChain(claims: AccessClaims): Promise<string> {
    const chain = randomToken(16);
    await this.redis.set(key.chain(chain), claims.uid, "EX", this.sessionTtlSeconds);
    return this.issue({ chain, ...claims }, this.sessionTtlSeconds);
  }

  async rotate(refreshToken: string): Promise<RotateResult> {
    const hash = hashToken(refreshToken);
    const raw = await this.redis.get(key.rt(hash));
    if (!raw) return { ok: false };
    const record = JSON.parse(raw) as RefreshRecord;
    const ttl = await this.redis.ttl(key.chain(record.chain));
    if (ttl <= 0) return { ok: false };
    const claims: AccessClaims = { uid: record.uid, email: record.email, name: record.name };

    if (await this.redis.get(key.used(hash))) {
      const graced = await this.redis.get(key.grace(hash));
      if (graced) return { ok: true, refreshToken: graced, claims };
      await this.redis.del(key.chain(record.chain));
      return { ok: false };
    }

    const next = randomToken();
    const claimed = await this.redis.set(key.grace(hash), next, "EX", REFRESH_GRACE_SECONDS, "NX");
    if (claimed !== "OK") {
      const graced = await this.redis.get(key.grace(hash));
      return graced ? { ok: true, refreshToken: graced, claims } : { ok: false };
    }
    await this.issueToken(next, record, ttl);
    await this.redis.set(key.used(hash), "1", "EX", ttl);
    return { ok: true, refreshToken: next, claims };
  }

  async revoke(refreshToken: string): Promise<void> {
    const raw = await this.redis.get(key.rt(hashToken(refreshToken)));
    if (!raw) return;
    const record = JSON.parse(raw) as RefreshRecord;
    await this.redis.del(key.chain(record.chain));
  }

  private async issue(record: RefreshRecord, ttl: number): Promise<string> {
    const token = randomToken();
    await this.issueToken(token, record, ttl);
    return token;
  }

  private async issueToken(token: string, record: RefreshRecord, ttl: number): Promise<void> {
    const value: RefreshRecord = {
      chain: record.chain,
      uid: record.uid,
      email: record.email,
      name: record.name,
    };
    await this.redis.set(key.rt(hashToken(token)), JSON.stringify(value), "EX", ttl);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/token-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/token-store.ts web/src/token-store.test.ts web/src/testing/mock-redis.ts
git commit -m "feat(web): add refresh token store with rotation and reuse detection"
```

---

### Task 3: web allowed origins and CORS (`origins.ts`)

**Files:**
- Create: `web/src/origins.ts`
- Test: `web/src/origins.test.ts`

**Interfaces:**
- Produces:
  - `const APP_ORIGINS: readonly string[]` = `["capacitor://localhost", "https://localhost"]`
  - `originOf(url: string): string | null`: returns `protocol + "//" + host`. Do **not** use `URL.origin`: it is `"null"` for `capacitor:` URLs.
  - `makeOriginCheck(serverOrigin: string | null, extra: string[]): (origin: string | null | undefined) => boolean`
  - `validateReturnTo(returnTo: string | undefined, isAllowed: (o: string) => boolean): string | null`: returns the value to redirect to (fragment stripped), `"/"` when absent, or `null` when rejected. Accepts paths that start with exactly one `/`.
  - `corsMiddleware(isAllowed: (origin: string) => boolean): MiddlewareHandler`

- [ ] **Step 1: Write the failing test**

`web/src/origins.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { originOf, makeOriginCheck, validateReturnTo, corsMiddleware } from "./origins.js";

const isAllowed = makeOriginCheck("https://rc.example.com", ["https://dev.example.com/"]);

describe("originOf", () => {
  it("handles http(s) and capacitor URLs", () => {
    expect(originOf("https://rc.example.com/a?b#c")).toBe("https://rc.example.com");
    expect(originOf("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(originOf("capacitor://localhost/s/x/")).toBe("capacitor://localhost");
  });

  it("returns null for junk", () => {
    expect(originOf("not a url")).toBeNull();
  });
});

describe("makeOriginCheck", () => {
  it("allows server, app and extra origins", () => {
    expect(isAllowed("https://rc.example.com")).toBe(true);
    expect(isAllowed("capacitor://localhost")).toBe(true);
    expect(isAllowed("https://localhost")).toBe(true);
    expect(isAllowed("https://dev.example.com")).toBe(true);
  });

  it("rejects others", () => {
    expect(isAllowed("https://evil.example.com")).toBe(false);
    expect(isAllowed("")).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });
});

describe("validateReturnTo", () => {
  it("defaults to /", () => {
    expect(validateReturnTo(undefined, isAllowed)).toBe("/");
    expect(validateReturnTo("", isAllowed)).toBe("/");
  });

  it("accepts same-origin paths and strips the fragment", () => {
    expect(validateReturnTo("/s/abc/?x=1#old", isAllowed)).toBe("/s/abc/?x=1");
  });

  it("rejects protocol-relative and backslash paths", () => {
    expect(validateReturnTo("//evil.example.com/", isAllowed)).toBeNull();
    expect(validateReturnTo("/\\evil.example.com/", isAllowed)).toBeNull();
  });

  it("accepts allowed absolute URLs", () => {
    expect(validateReturnTo("capacitor://localhost/", isAllowed)).toBe("capacitor://localhost/");
    expect(validateReturnTo("https://localhost/s/x/#y", isAllowed)).toBe("https://localhost/s/x/");
  });

  it("rejects other absolute URLs", () => {
    expect(validateReturnTo("https://evil.example.com/", isAllowed)).toBeNull();
    expect(validateReturnTo("javascript:alert(1)", isAllowed)).toBeNull();
  });
});

describe("corsMiddleware", () => {
  const app = new Hono();
  app.use("*", corsMiddleware((o) => isAllowed(o)));
  app.get("/x", (c) => c.text("ok"));

  it("answers preflight for allowed origins", async () => {
    const res = await app.request("/x", {
      method: "OPTIONS",
      headers: {
        origin: "capacitor://localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,x-opencode-directory",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("sets allow-origin on normal responses", async () => {
    const res = await app.request("/x", { headers: { origin: "https://localhost" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://localhost");
  });

  it("omits allow-origin for other origins", async () => {
    const res = await app.request("/x", { headers: { origin: "https://evil.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/origins.test.ts`
Expected: FAIL, cannot resolve `./origins.js`.

- [ ] **Step 3: Write the implementation**

`web/src/origins.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

export const APP_ORIGINS: readonly string[] = ["capacitor://localhost", "https://localhost"];

// URL.origin is "null" for non-special schemes like capacitor:, so build it by hand.
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.host) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function makeOriginCheck(serverOrigin: string | null, extra: string[]) {
  const allowed = new Set<string>(APP_ORIGINS);
  for (const o of extra) {
    const trimmed = o.trim().replace(/\/+$/, "");
    if (trimmed) allowed.add(trimmed);
  }
  if (serverOrigin) allowed.add(serverOrigin);
  return (origin: string | null | undefined): boolean => !!origin && allowed.has(origin);
}

export function validateReturnTo(
  returnTo: string | undefined,
  isAllowed: (origin: string) => boolean,
): string | null {
  if (!returnTo) return "/";
  const withoutFragment = returnTo.split("#")[0];
  if (withoutFragment.startsWith("/")) {
    const second = withoutFragment[1];
    if (second === "/" || second === "\\") return null;
    return withoutFragment;
  }
  const origin = originOf(withoutFragment);
  if (!origin || !isAllowed(origin)) return null;
  return withoutFragment;
}

export function corsMiddleware(isAllowed: (origin: string) => boolean): MiddlewareHandler {
  return cors({
    origin: (origin) => (isAllowed(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // allowHeaders omitted: hono reflects Access-Control-Request-Headers,
    // which covers Authorization, Content-Type and opencode's x-opencode-* headers.
    maxAge: 600,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/origins.test.ts`
Expected: PASS (11 tests). If the "omits allow-origin" test fails because hono sets the header to an empty string, change the assertion to `expect(res.headers.get("access-control-allow-origin") ?? "").toBe("")`. Check hono's behaviour first with `console.log`; do not weaken the "allowed" assertions.

- [ ] **Step 5: Commit**

```bash
git add web/src/origins.ts web/src/origins.test.ts
git commit -m "feat(web): add allowed-origin checks and CORS middleware"
```

---

### Task 4: web config and auth routes (bearer middleware)

**Files:**
- Modify: `web/src/config.ts`
- Modify: `web/src/config.test.ts`
- Rewrite: `web/src/auth.ts`
- Rewrite: `web/src/auth.test.ts`
- Delete: `web/src/cookie.ts`, `web/src/cookie.test.ts`

**Interfaces:**
- Consumes: Task 1 (`signAccessToken`, `verifyAccessToken`, `randomToken`, `AccessClaims`), Task 2 (`TokenStore`), Task 3 (`validateReturnTo`).
- Produces:
  - `Config` fields `tokenSecret: Uint8Array`, `accessTokenTtl: number` (seconds), `sessionTtl: number` (seconds), `allowedOrigins: string[]`, `secureCookies: boolean`. `cookieSecret` and `cookieDomain` are removed.
  - `parseDuration(value: string): number` (seconds; accepts `<int>s|m|h|d`)
  - `type AuthEnv = { Variables: { userId: string; claims: AccessClaims; token: string } }`
  - `authMiddleware(config: Pick<Config, "tokenSecret">)`
  - `authRoutes(deps: { config: Config; provider: OIDCProvider; tokens: TokenStore; isAllowedOrigin: (o: string) => boolean }): Hono`
  - `bearerToken(c: Context): string | null`

- [ ] **Step 1: Write failing config tests**

In `web/src/config.test.ts`:
- In `validEnv`, replace `COOKIE_SECRET: "ab".repeat(32),` with `TOKEN_SECRET: "ab".repeat(32),`.
- In `beforeEach`, add `delete process.env.COOKIE_SECRET; delete process.env.ACCESS_TOKEN_TTL; delete process.env.SESSION_TTL; delete process.env.ALLOWED_ORIGINS;` and remove `delete process.env.COOKIE_DOMAIN;`.
- In "loads required fields from env", replace the two `cookieSecret` expectations with `expect(config.tokenSecret).toBeInstanceOf(Uint8Array); expect(config.tokenSecret.length).toBe(32);`.
- In "defaults optional fields", remove `expect(config.cookieDomain).toBe("");` and add:

```ts
    expect(config.accessTokenTtl).toBe(900);
    expect(config.sessionTtl).toBe(7 * 24 * 3600);
    expect(config.allowedOrigins).toEqual([]);
```

- Update any existing test that deletes or sets `COOKIE_SECRET` to test missing/invalid secrets so it uses `TOKEN_SECRET` instead, and keep its expectation.
- Append:

```ts
describe("token settings", () => {
  it("falls back to COOKIE_SECRET", () => {
    delete process.env.TOKEN_SECRET;
    process.env.COOKIE_SECRET = "cd".repeat(32);
    const config = loadConfig();
    expect(Buffer.from(config.tokenSecret).toString("hex")).toBe("cd".repeat(32));
  });

  it("parses TTLs and allowed origins", () => {
    process.env.ACCESS_TOKEN_TTL = "5m";
    process.env.SESSION_TTL = "2d";
    process.env.ALLOWED_ORIGINS = "https://a.example.com, https://b.example.com";
    const config = loadConfig();
    expect(config.accessTokenTtl).toBe(300);
    expect(config.sessionTtl).toBe(172800);
    expect(config.allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });
});

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("1h")).toBe(3600);
    expect(parseDuration("7d")).toBe(604800);
  });

  it("rejects invalid input", () => {
    expect(() => parseDuration("15")).toThrow();
    expect(() => parseDuration("0m")).toThrow();
    expect(() => parseDuration("1w")).toThrow();
  });
});
```

and change the import at the top to `import { loadConfig, parseDuration } from "./config.js";`.

- [ ] **Step 2: Run config tests to verify they fail**

Run: `cd web && npx vitest run src/config.test.ts`
Expected: FAIL (`parseDuration` not exported, `tokenSecret` undefined).

- [ ] **Step 3: Implement config**

Replace `web/src/config.ts` with:

```ts
export interface Config {
  port: number;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcCliClientId: string;
  oidcRedirectUri: string;
  oidcIssuerOverride: string;
  oidcAuthorizationEndpoint: string;
  oidcTokenEndpoint: string;
  oidcJwksUri: string;
  tokenSecret: Uint8Array;
  accessTokenTtl: number;
  sessionTtl: number;
  allowedOrigins: string[];
  secureCookies: boolean;
  redisUrl: string;
  webUiDir: string;
  gatewayUrl: string;
  tlsInsecureSkipVerify: boolean;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is required`);
  return val;
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration: ${value}`);
  const seconds = parseInt(match[1], 10) * UNITS[match[2]];
  if (seconds <= 0) throw new Error(`duration must be positive: ${value}`);
  return seconds;
}

export function loadConfig(): Config {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  const secretHex = process.env.TOKEN_SECRET || process.env.COOKIE_SECRET;
  if (!secretHex) throw new Error("TOKEN_SECRET is required");
  const secret = Buffer.from(secretHex, "hex");
  if (secret.length !== 32) {
    throw new Error("TOKEN_SECRET must be a 64-char hex string (32 bytes)");
  }

  return {
    port,
    oidcIssuer: requireEnv("OIDC_ISSUER"),
    oidcClientId: requireEnv("OIDC_CLIENT_ID"),
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
    oidcCliClientId: process.env.OIDC_CLI_CLIENT_ID ?? "",
    oidcRedirectUri: requireEnv("OIDC_REDIRECT_URI"),
    oidcIssuerOverride: process.env.OIDC_ISSUER_OVERRIDE ?? "",
    oidcAuthorizationEndpoint: process.env.OIDC_AUTHORIZATION_ENDPOINT ?? "",
    oidcTokenEndpoint: process.env.OIDC_TOKEN_ENDPOINT ?? "",
    oidcJwksUri: process.env.OIDC_JWKS_URI ?? "",
    tokenSecret: new Uint8Array(secret),
    accessTokenTtl: parseDuration(process.env.ACCESS_TOKEN_TTL || "15m"),
    sessionTtl: parseDuration(process.env.SESSION_TTL || "7d"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    secureCookies: process.env.COOKIE_SECURE !== "false",
    redisUrl: requireEnv("REDIS_URL"),
    webUiDir: process.env.WEBUI_DIR ?? "",
    gatewayUrl: process.env.GATEWAY_URL ?? "",
    tlsInsecureSkipVerify: process.env.TLS_INSECURE_SKIP_VERIFY === "true",
  };
}
```

Run: `cd web && npx vitest run src/config.test.ts`
Expected: PASS. If an existing test asserts the old message `"COOKIE_SECRET must be a 64-char hex string"`, update it to `"TOKEN_SECRET must be a 64-char hex string"`.

- [ ] **Step 4: Write failing auth tests**

Replace `web/src/auth.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware, authRoutes, type AuthEnv } from "./auth.js";
import { signAccessToken } from "./token.js";
import { TokenStore } from "./token-store.js";
import { MockRedis } from "./testing/mock-redis.js";
import { makeOriginCheck } from "./origins.js";
import type { Config } from "./config.js";
import type { OIDCProvider } from "./oidc.js";

const secret = new Uint8Array(32).fill(0xab);
const claims = { uid: "alice@example.com", email: "alice@example.com", name: "Alice" };

const config: Config = {
  port: 8080,
  oidcIssuer: "https://idp.example.com",
  oidcClientId: "test",
  oidcClientSecret: "",
  oidcCliClientId: "",
  oidcRedirectUri: "https://rc.example.com/auth/callback",
  oidcIssuerOverride: "",
  oidcAuthorizationEndpoint: "",
  oidcTokenEndpoint: "",
  oidcJwksUri: "",
  tokenSecret: secret,
  accessTokenTtl: 900,
  sessionTtl: 7 * 24 * 3600,
  allowedOrigins: [],
  secureCookies: false,
  redisUrl: "redis://localhost:6379/0",
  webUiDir: "",
  gatewayUrl: "",
  tlsInsecureSkipVerify: false,
};

const provider = {
  discovery: {
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
    issuer: "https://idp.example.com",
  },
  jwks: (() => {}) as unknown,
} as OIDCProvider;

let tokens: TokenStore;
let app: Hono<AuthEnv>;

beforeEach(() => {
  tokens = new TokenStore(new MockRedis(), config.sessionTtl);
  app = new Hono<AuthEnv>();
  app.route(
    "/",
    authRoutes({
      config,
      provider,
      tokens,
      isAllowedOrigin: makeOriginCheck("https://rc.example.com", []),
    }),
  );
  app.get("/protected", authMiddleware(config), (c) =>
    c.json({ userId: c.get("userId"), token: c.get("token") }),
  );
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("authMiddleware", () => {
  it("returns 401 without a token", async () => {
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts a valid bearer token", async () => {
    const token = signAccessToken(claims, secret, 900);
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "alice@example.com", token });
  });

  it("rejects an expired token", async () => {
    const token = signAccessToken(claims, secret, 900, Date.now() - 1_000_000);
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("ignores access_token query on normal requests", async () => {
    const token = signAccessToken(claims, secret, 900);
    const res = await app.request(`/protected?access_token=${token}`);
    expect(res.status).toBe(401);
  });

  it("accepts access_token query on websocket upgrades", async () => {
    const token = signAccessToken(claims, secret, 900);
    const res = await app.request(`/protected?access_token=${token}`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(200);
  });

  it("ignores the old session cookie", async () => {
    const res = await app.request("/protected", { headers: { cookie: "orc_session=abc.def" } });
    expect(res.status).toBe(401);
  });
});

describe("/auth/start", () => {
  it("redirects to the IdP and stores state and return_to", async () => {
    const res = await app.request("/auth/start?return_to=capacitor%3A%2F%2Flocalhost%2F");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/idp\.example\.com\/authorize\?/);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("orc_state=");
    expect(cookies).toContain("orc_return=capacitor%3A%2F%2Flocalhost%2F");
  });

  it("rejects a foreign return_to", async () => {
    const res = await app.request("/auth/start?return_to=https%3A%2F%2Fevil.example.com%2F");
    expect(res.status).toBe(400);
  });
});

describe("/auth/token", () => {
  it("exchanges a code for tokens once", async () => {
    const code = await tokens.createCode(claims);
    const res = await post("/auth/token", { code });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expires_in).toBe(900);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");

    const again = await post("/auth/token", { code });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_grant" });
  });

  it("rejects a missing code", async () => {
    const res = await post("/auth/token", {});
    expect(res.status).toBe(400);
  });
});

describe("/auth/refresh and /auth/logout", () => {
  async function login() {
    const code = await tokens.createCode(claims);
    return (await (await post("/auth/token", { code })).json()) as {
      access_token: string;
      refresh_token: string;
    };
  }

  it("rotates the refresh token and issues a working access token", async () => {
    const first = await login();
    const res = await post("/auth/refresh", { refresh_token: first.refresh_token });
    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.refresh_token).not.toBe(first.refresh_token);
    const me = await app.request("/protected", {
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(me.status).toBe(200);
  });

  it("returns 401 invalid_grant for an unknown token", async () => {
    const res = await post("/auth/refresh", { refresh_token: "nope" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  it("logout revokes the chain", async () => {
    const first = await login();
    const out = await post("/auth/logout", { refresh_token: first.refresh_token });
    expect(out.status).toBe(204);
    const res = await post("/auth/refresh", { refresh_token: first.refresh_token });
    expect(res.status).toBe(401);
  });

  it("returns 503 when Redis fails", async () => {
    const broken = new TokenStore(
      {
        get: async () => { throw new Error("down"); },
        getdel: async () => { throw new Error("down"); },
        set: async () => { throw new Error("down"); },
        del: async () => { throw new Error("down"); },
        ttl: async () => { throw new Error("down"); },
      },
      config.sessionTtl,
    );
    const a = new Hono();
    a.route("/", authRoutes({ config, provider, tokens: broken, isAllowedOrigin: () => false }));
    const res = await a.request("/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "x" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
```

- [ ] **Step 5: Run auth tests to verify they fail**

Run: `cd web && npx vitest run src/auth.test.ts`
Expected: FAIL (`authRoutes` takes the old signature, `/auth/token` missing).

- [ ] **Step 6: Implement auth**

Replace `web/src/auth.ts` with:

```ts
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Config } from "./config.js";
import type { OIDCProvider } from "./oidc.js";
import { verifyToken } from "./oidc.js";
import { randomToken, signAccessToken, verifyAccessToken, type AccessClaims } from "./token.js";
import type { TokenStore } from "./token-store.js";
import { validateReturnTo } from "./origins.js";

export type AuthEnv = {
  Variables: {
    userId: string;
    claims: AccessClaims;
    token: string;
  };
};

export function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  if ((c.req.header("upgrade") ?? "").toLowerCase() === "websocket") {
    return c.req.query("access_token") ?? null;
  }
  return null;
}

export function authMiddleware(config: Pick<Config, "tokenSecret">) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = bearerToken(c);
    const claims = token ? verifyAccessToken(token, config.tokenSecret) : null;
    if (!token || !claims) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", claims.uid);
    c.set("claims", claims);
    c.set("token", token);
    await next();
  });
}

interface AuthDeps {
  config: Config;
  provider: OIDCProvider;
  tokens: TokenStore;
  isAllowedOrigin: (origin: string) => boolean;
}

function tokenResponse(c: Context, config: Config, claims: AccessClaims, refreshToken: string) {
  return c.json({
    access_token: signAccessToken(claims, config.tokenSecret, config.accessTokenTtl),
    refresh_token: refreshToken,
    expires_in: config.accessTokenTtl,
  });
}

async function readField(c: Context, field: string): Promise<string | null> {
  try {
    const body = await c.req.json();
    const value = body?.[field];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

export function authRoutes({ config, provider, tokens, isAllowedOrigin }: AuthDeps) {
  const app = new Hono();
  const authCookie = { path: "/auth", maxAge: 300, httpOnly: true, sameSite: "Lax" as const, secure: config.secureCookies };

  app.get("/auth/start", (c) => {
    const returnTo = validateReturnTo(c.req.query("return_to"), isAllowedOrigin);
    if (!returnTo) return c.json({ error: "invalid return_to" }, 400);

    const state = randomToken(16);
    setCookie(c, "orc_state", state, authCookie);
    setCookie(c, "orc_return", encodeURIComponent(returnTo), authCookie);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.oidcClientId,
      redirect_uri: config.oidcRedirectUri,
      scope: "openid email profile",
      state,
    });
    return c.redirect(`${provider.discovery.authorization_endpoint}?${params}`);
  });

  app.get("/auth/callback", async (c) => {
    const stateCookie = getCookie(c, "orc_state");
    const stateParam = c.req.query("state");
    if (!stateCookie || stateCookie !== stateParam) {
      return c.text("invalid state", 400);
    }
    const returnTo =
      validateReturnTo(decodeURIComponent(getCookie(c, "orc_return") ?? ""), isAllowedOrigin) ?? "/";

    const code = c.req.query("code");
    if (!code) {
      return c.text("missing code", 400);
    }

    const tokenParams: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: config.oidcClientId,
      code,
      redirect_uri: config.oidcRedirectUri,
    };
    if (config.oidcClientSecret) {
      tokenParams.client_secret = config.oidcClientSecret;
    }

    const tokenRes = await fetch(provider.discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenParams),
    });
    if (!tokenRes.ok) {
      console.error(`OIDC token exchange failed: ${tokenRes.status}`);
      return c.text("authentication failed", 401);
    }

    const tokenData = (await tokenRes.json()) as { id_token?: string };
    if (!tokenData.id_token) {
      return c.text("no id_token in response", 401);
    }

    let idClaims: { email?: string; sub?: string; name?: string };
    try {
      idClaims = (await verifyToken(provider, tokenData.id_token, config.oidcClientId)) as typeof idClaims;
    } catch (err) {
      console.error("ID token verification failed:", err);
      return c.text("invalid id_token", 401);
    }

    const claims: AccessClaims = {
      uid: idClaims.email || idClaims.sub || "",
      email: idClaims.email ?? "",
      name: idClaims.name ?? "",
    };

    let loginCode: string;
    try {
      loginCode = await tokens.createCode(claims);
    } catch (err) {
      console.error("login code store failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }

    deleteCookie(c, "orc_state", { path: "/auth" });
    deleteCookie(c, "orc_return", { path: "/auth" });
    console.log(`login: user=${claims.uid} name=${claims.name}`);
    return c.redirect(`${returnTo}#code=${encodeURIComponent(loginCode)}`);
  });

  app.post("/auth/token", async (c) => {
    const code = await readField(c, "code");
    if (!code) return c.json({ error: "invalid_grant" }, 400);
    try {
      const claims = await tokens.consumeCode(code);
      if (!claims) return c.json({ error: "invalid_grant" }, 400);
      const refreshToken = await tokens.createChain(claims);
      return tokenResponse(c, config, claims, refreshToken);
    } catch (err) {
      console.error("token exchange failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
  });

  app.post("/auth/refresh", async (c) => {
    const refreshToken = await readField(c, "refresh_token");
    if (!refreshToken) return c.json({ error: "invalid_grant" }, 401);
    try {
      const result = await tokens.rotate(refreshToken);
      if (!result.ok) return c.json({ error: "invalid_grant" }, 401);
      return tokenResponse(c, config, result.claims, result.refreshToken);
    } catch (err) {
      console.error("refresh failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
  });

  app.post("/auth/logout", async (c) => {
    const refreshToken = await readField(c, "refresh_token");
    if (refreshToken) {
      try {
        await tokens.revoke(refreshToken);
      } catch (err) {
        console.error("logout revoke failed:", err);
      }
    }
    return c.body(null, 204);
  });

  return app;
}
```

Delete the old cookie module:

```bash
git rm web/src/cookie.ts web/src/cookie.test.ts
```

- [ ] **Step 7: Run auth tests to verify they pass**

Run: `cd web && npx vitest run src/auth.test.ts src/config.test.ts`
Expected: PASS. (`src/index.ts` does not compile yet; it is fixed in Task 5. vitest does not load it.)

- [ ] **Step 8: Commit**

```bash
git add web/src/config.ts web/src/config.test.ts web/src/auth.ts web/src/auth.test.ts
git commit -m "feat(web): replace session cookie with bearer tokens and /auth/token, /auth/refresh"
```

---

### Task 5: web path layout (`/proxy/:id/*` + SPA fallback)

**Files:**
- Rewrite: `web/src/proxy.ts`
- Test: `web/src/proxy.test.ts`
- Rewrite: `web/src/webui.ts`
- Test: `web/src/webui.test.ts`
- Modify: `web/src/index.ts`

**Interfaces:**
- Consumes: `AuthEnv`, `authMiddleware`, `authRoutes` (Task 4); `TokenStore`, `RedisLike` (Task 2); `makeOriginCheck`, `originOf`, `corsMiddleware` (Task 3); `SessionStore`, `SessionMeta` (existing `store.ts`).
- Produces:
  - `type ProxyEnv = AuthEnv & { Variables: { session: SessionMeta } }`
  - `sessionAccess(store: SessionStore): MiddlewareHandler<ProxyEnv>`: 404 unless the session exists and `meta.userId === c.get("userId")`; 502 if it has no `gatewayAddr`.
  - `proxyRest(path: string, sessionId: string): string`: the path after `/proxy/<id>`, with repeated slashes collapsed, at least `/`.
  - `upstreamUrl(scheme: "http" | "ws", gatewayAddr: string, sessionId: string, rest: string, search: string): string`: drops `access_token` from the query.
  - `proxyHttp(): Handler<ProxyEnv>`
  - `resolveSpaFile(webUiDir: string, urlPath: string): string | null` (null when the UI dir or index.html is missing)
  - `spaHandler(webUiDir: string): Handler`

- [ ] **Step 1: Write failing proxy tests**

`web/src/proxy.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { proxyRest, upstreamUrl, sessionAccess, proxyHttp, type ProxyEnv } from "./proxy.js";
import type { SessionStore, SessionMeta } from "./store.js";

const meta: SessionMeta = {
  id: "alice-dev",
  userId: "alice@example.com",
  directory: "/project",
  gatewayAddr: "10.0.0.5:9090",
  createdAt: "2026-01-01T00:00:00Z",
};

const store = { get: async (id: string) => (id === meta.id ? meta : null) } as unknown as SessionStore;

function makeApp(userId: string) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("token", "tok");
    await next();
  });
  app.all("/proxy/:sessionId/*", sessionAccess(store), proxyHttp());
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe("proxyRest", () => {
  it("returns the path after the session prefix", () => {
    expect(proxyRest("/proxy/alice-dev/api/health", "alice-dev")).toBe("/api/health");
    expect(proxyRest("/proxy/alice-dev//pty/1/connect", "alice-dev")).toBe("/pty/1/connect");
    expect(proxyRest("/proxy/alice-dev", "alice-dev")).toBe("/");
  });
});

describe("upstreamUrl", () => {
  it("builds gateway URLs and drops access_token", () => {
    expect(upstreamUrl("http", "10.0.0.5:9090", "s1", "/api/x", "?a=1&access_token=t&b=2")).toBe(
      "http://10.0.0.5:9090/proxy/s1/api/x?a=1&b=2",
    );
    expect(upstreamUrl("ws", "10.0.0.5:9090", "s1", "/pty/1/connect", "")).toBe(
      "ws://10.0.0.5:9090/proxy/s1/pty/1/connect",
    );
  });
});

describe("proxy routes", () => {
  it("returns 404 for another user's session", async () => {
    const res = await makeApp("bob@example.com").request("/proxy/alice-dev/api/health");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await makeApp("alice@example.com").request("/proxy/nope/api/health");
    expect(res.status).toBe(404);
  });

  it("forwards to the gateway with bearer and directory headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      }),
    );
    const res = await makeApp("alice@example.com").request("/proxy/alice-dev/api/health?x=1", {
      headers: { authorization: "Bearer tok", origin: "capacitor://localhost" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.0.0.5:9090/proxy/alice-dev/api/health?x=1");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-opencode-directory")).toBe("/project");
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("host")).toBeNull();
  });
});
```

- [ ] **Step 2: Run proxy tests to verify they fail**

Run: `cd web && npx vitest run src/proxy.test.ts`
Expected: FAIL (`proxyRest` not exported).

- [ ] **Step 3: Implement proxy**

Replace `web/src/proxy.ts` with:

```ts
import type { Handler, MiddlewareHandler } from "hono";
import type { SessionStore, SessionMeta } from "./store.js";
import type { AuthEnv } from "./auth.js";

export type ProxyEnv = AuthEnv & { Variables: { session: SessionMeta } };

export function proxyRest(path: string, sessionId: string): string {
  const rest = path.slice(`/proxy/${sessionId}`.length).replace(/\/{2,}/g, "/");
  return rest.startsWith("/") ? rest : `/${rest}`;
}

export function upstreamUrl(
  scheme: "http" | "ws",
  gatewayAddr: string,
  sessionId: string,
  rest: string,
  search: string,
): string {
  const params = new URLSearchParams(search);
  params.delete("access_token");
  const qs = params.toString();
  return `${scheme}://${gatewayAddr}/proxy/${sessionId}${rest}${qs ? `?${qs}` : ""}`;
}

export function sessionAccess(store: SessionStore): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const sessionId = c.req.param("sessionId")!;
    const meta = await store.get(sessionId);
    if (!meta || meta.userId !== c.get("userId")) {
      return c.text("session not found", 404);
    }
    if (!meta.gatewayAddr) {
      return c.text("session has no gateway", 502);
    }
    c.set("session", meta);
    await next();
  };
}

export function proxyHttp(): Handler<ProxyEnv> {
  return async (c) => {
    const meta = c.get("session");
    const url = upstreamUrl(
      "http",
      meta.gatewayAddr,
      meta.id,
      proxyRest(c.req.path, meta.id),
      new URL(c.req.url).search,
    );

    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Opencode-Directory", meta.directory);
    headers.set("Authorization", `Bearer ${c.get("token")}`);
    headers.delete("host");
    // The browser origin (e.g. capacitor://localhost) means nothing to opencode's own CORS check.
    headers.delete("origin");

    const upstream = await fetch(url, {
      method: c.req.method,
      headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      redirect: "manual",
    });

    // Drop opencode's CORS headers; web's CORS middleware owns them.
    const out = new Headers(upstream.headers);
    for (const name of [...out.keys()]) {
      if (name.startsWith("access-control-")) out.delete(name);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
```

Run: `cd web && npx vitest run src/proxy.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 4: Write failing SPA tests**

`web/src/webui.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSpaFile } from "./webui.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "webui-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
});

describe("resolveSpaFile", () => {
  it("serves existing files", () => {
    expect(resolveSpaFile(dir, "/assets/app.js")).toBe(join(dir, "assets", "app.js"));
  });

  it("falls back to index.html for client routes", () => {
    expect(resolveSpaFile(dir, "/s/alice-dev/")).toBe(join(dir, "index.html"));
    expect(resolveSpaFile(dir, "/s/alice-dev/abc/session/ses_1")).toBe(join(dir, "index.html"));
    expect(resolveSpaFile(dir, "/")).toBe(join(dir, "index.html"));
  });

  it("does not escape the UI directory", () => {
    expect(resolveSpaFile(dir, "/../../etc/passwd")).toBe(join(dir, "index.html"));
  });

  it("returns null when the UI is missing", () => {
    expect(resolveSpaFile(join(dir, "nope"), "/")).toBeNull();
  });
});
```

- [ ] **Step 5: Run SPA tests to verify they fail**

Run: `cd web && npx vitest run src/webui.test.ts`
Expected: FAIL (`resolveSpaFile` not exported).

- [ ] **Step 6: Implement the SPA handler**

Replace `web/src/webui.ts` with:

```ts
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Handler } from "hono";

export function resolveSpaFile(webUiDir: string, urlPath: string): string | null {
  const root = resolve(webUiDir);
  const index = join(root, "index.html");
  if (!existsSync(index)) return null;

  const candidate = resolve(root, "." + decodeURIComponent(urlPath));
  if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  return index;
}

export function spaHandler(webUiDir: string): Handler {
  return (c) => {
    const file = resolveSpaFile(webUiDir, c.req.path);
    if (!file) return c.text("web UI not configured", 404);
    return new Response(Bun.file(file));
  };
}
```

Run: `cd web && npx vitest run src/webui.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Wire up `index.ts`**

Replace everything in `web/src/index.ts` from `const app = new Hono<AuthEnv>();` to the end of the file (this also removes `dashboardHTML`) with:

```ts
const tokens = new TokenStore(redis as unknown as RedisLike, config.sessionTtl);
const isAllowedOrigin = makeOriginCheck(originOf(config.oidcRedirectUri), config.allowedOrigins);

const app = new Hono<AuthEnv>();
app.use("*", logger());
app.use("*", corsMiddleware(isAllowedOrigin));

// Health check (no auth)
app.get("/healthz", async (c) => {
  const ok = await store.ping();
  return c.json({ status: ok ? "ok" : "degraded", version });
});

// Auth routes (no auth middleware)
app.route("/", authRoutes({ config, provider, tokens, isAllowedOrigin }));

// Protected routes
const auth = authMiddleware(config);

app.get("/api/me", auth, (c) => {
  const claims = c.get("claims");
  return c.json({ sub: claims.uid, email: claims.email, name: claims.name });
});

app.get("/gateway/sessions", auth, async (c) => {
  const userId = c.get("userId");
  const sessions = await store.list(userId);
  return c.json(sessions.map((s) => ({ ...s, user: s.userId })));
});

// OpenCode API proxy: HTTP, SSE (and WebSocket, added in the next task)
app.all("/proxy/:sessionId/*", auth, sessionAccess(store), proxyHttp());

// SPA: static files, client routes (including /s/:id/...) fall back to index.html
if (config.webUiDir) {
  app.get("*", spaHandler(config.webUiDir));
}

console.log(`web starting version=${version} addr=:${config.port}`);

export default {
  port: config.port,
  fetch: app.fetch,
};
```

And replace the imports at the top of `web/src/index.ts` (the lines importing `./auth.js`, `./store.js` and `./webui.js`) with:

```ts
import { authRoutes, authMiddleware, type AuthEnv } from "./auth.js";
import { SessionStore } from "./store.js";
import { TokenStore, type RedisLike } from "./token-store.js";
import { corsMiddleware, makeOriginCheck, originOf } from "./origins.js";
import { proxyHttp, sessionAccess } from "./proxy.js";
import { spaHandler } from "./webui.js";
```

- [ ] **Step 8: Type-check and run all web tests**

Run: `cd web && npx tsc --noEmit -p . && npx vitest run`
Expected: no type errors; all test files pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/proxy.ts web/src/proxy.test.ts web/src/webui.ts web/src/webui.test.ts web/src/index.ts
git commit -m "feat(web): move API proxy to /proxy/:id and serve SPA routes without auth"
```

---

### Task 6: web WebSocket relay

**Files:**
- Create: `web/src/ws-relay.ts`
- Test: `web/src/ws-relay.test.ts`
- Modify: `web/src/index.ts`

**Interfaces:**
- Consumes: `ProxyEnv`, `proxyRest`, `upstreamUrl`, `sessionAccess` (Task 5); `authMiddleware` (Task 4).
- Produces:
  - `relayCloseCode(code: number): number`: maps codes that cannot be sent in a close frame (1005, 1006, 1015) to sendable ones.
  - `isUpgrade(c: Context): boolean`
  - `wsRelay(): MiddlewareHandler<ProxyEnv>`: upgrades and relays; calls `next()` for non-upgrade requests.

- [ ] **Step 1: Write the failing test**

`web/src/ws-relay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { relayCloseCode } from "./ws-relay.js";

describe("relayCloseCode", () => {
  it("passes through normal codes", () => {
    expect(relayCloseCode(1000)).toBe(1000);
    expect(relayCloseCode(1001)).toBe(1001);
    expect(relayCloseCode(4001)).toBe(4001);
  });

  it("maps codes that cannot be sent", () => {
    expect(relayCloseCode(1005)).toBe(1000);
    expect(relayCloseCode(1006)).toBe(1011);
    expect(relayCloseCode(1015)).toBe(1011);
  });
});
```

(`ws-relay.ts` imports `hono/bun`, which only resolves under Bun. Keep `relayCloseCode` in a file with no Bun imports: put it in `web/src/ws-close.ts`, re-export it from `ws-relay.ts`, and point the test's import at `./ws-close.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/ws-relay.test.ts`
Expected: FAIL, cannot resolve `./ws-close.js`.

- [ ] **Step 3: Implement**

`web/src/ws-close.ts`:

```ts
// 1005 (no status), 1006 (abnormal) and 1015 (TLS) are reserved: they can be
// received but must not be sent in a close frame.
export function relayCloseCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  return code;
}
```

`web/src/ws-relay.ts`:

```ts
import type { Context, MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { ProxyEnv } from "./proxy.js";
import { proxyRest, upstreamUrl } from "./proxy.js";
import { relayCloseCode } from "./ws-close.js";

export { relayCloseCode };

export function isUpgrade(c: Context): boolean {
  return (c.req.header("upgrade") ?? "").toLowerCase() === "websocket";
}

type Frame = string | ArrayBuffer;

const upgrade = upgradeWebSocket((c: Context<ProxyEnv>) => {
  const meta = c.get("session");
  const token = c.get("token");
  const target = upstreamUrl(
    "ws",
    meta.gatewayAddr,
    meta.id,
    proxyRest(c.req.path, meta.id),
    new URL(c.req.url).search,
  );

  let upstream: WebSocket | undefined;
  const pending: Frame[] = [];

  return {
    onOpen(_evt, ws) {
      // Bun's WebSocket client accepts headers in the second argument.
      upstream = new WebSocket(target, {
        headers: { Authorization: `Bearer ${token}` },
      } as unknown as string[]);
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const frame of pending.splice(0)) upstream!.send(frame);
      };
      upstream.onmessage = (e) => ws.send(e.data as Frame);
      upstream.onclose = (e) => ws.close(relayCloseCode(e.code), e.reason);
      upstream.onerror = () => ws.close(1011, "upstream error");
    },
    onMessage(evt) {
      const frame = evt.data as Frame;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
      else pending.push(frame);
    },
    onClose() {
      upstream?.close();
    },
  };
});

export function wsRelay(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    if (!isUpgrade(c)) return next();
    return upgrade(c, next);
  };
}
```

- [ ] **Step 4: Wire into `index.ts`**

In `web/src/index.ts`:
- Add imports: `import { websocket } from "hono/bun";` and `import { wsRelay } from "./ws-relay.js";`.
- Replace the proxy route line with:

```ts
// OpenCode API proxy: WebSocket upgrades first, then HTTP and SSE
app.get("/proxy/:sessionId/*", auth, sessionAccess(store), wsRelay());
app.all("/proxy/:sessionId/*", auth, sessionAccess(store), proxyHttp());
```

Note: for a non-upgrade GET, `auth` and `sessionAccess` run twice (once per route). Both are cheap (HMAC + one Redis GET). Accept that for now; don't merge the routes, because `upgradeWebSocket` must return before any body handling.

- Change the default export to:

```ts
export default {
  port: config.port,
  fetch: app.fetch,
  websocket,
};
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd web && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 6: Smoke-test the relay under Bun**

This needs a gateway, so it is covered end-to-end in Task 12 (terminal WebSocket round trip). Here, just confirm the server starts:

Run: `cd web && TOKEN_SECRET=$(printf 'ab%.0s' {1..32}) OIDC_ISSUER=http://127.0.0.1:1 OIDC_CLIENT_ID=x OIDC_REDIRECT_URI=http://localhost/auth/callback REDIS_URL=redis://127.0.0.1:1 timeout 5 bun run src/index.ts; echo exit=$?`
Expected: it fails on Redis or OIDC connection (not on an import or syntax error). Any `SyntaxError` or `Cannot find module` means the wiring is wrong.

- [ ] **Step 7: Commit**

```bash
git add web/src/ws-relay.ts web/src/ws-close.ts web/src/ws-relay.test.ts web/src/index.ts
git commit -m "feat(web): relay WebSocket upgrades on /proxy/:id to the gateway"
```

---

### Task 7: gateway bearer auth

**Files:**
- Create: `gateway/token.go`
- Test: `gateway/token_test.go`
- Delete: `gateway/cookie.go`
- Modify: `gateway/gateway_proxy.go`, `gateway/gateway_proxy_test.go`, `gateway/routes_gateway.go`, `gateway/config.go`, `gateway/config_test.go`, `gateway/main.go`, `gateway/main_test.go`

**Interfaces:**
- Produces:
  - `type AccessClaims struct { Typ string; UID string; Email string; Name string; Exp int64 }` (JSON tags `typ`, `uid`, `email`, `name`, `exp`)
  - `func verifyAccessToken(token string, secret []byte, now time.Time) (*AccessClaims, bool)`
  - `func bearerToken(r *http.Request) string`: `Authorization: Bearer`, or `access_token` query on WebSocket upgrades.
  - `func stripAccessToken(rawQuery string) string`
  - `Config.TokenSecret []byte` (replaces `CookieSecret`)
  - `GatewayProxyHandler(registry *TunnelRegistry, tokenSecret []byte) http.Handler`

- [ ] **Step 1: Write the failing unit tests**

`gateway/token_test.go`:

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

var testTokenSecret = []byte("0123456789abcdef0123456789abcdef")

func signTestToken(t *testing.T, claims map[string]any) string {
	t.Helper()
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, testTokenSecret)
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func testAccessToken(t *testing.T, uid string) string {
	return signTestToken(t, map[string]any{
		"typ": "access", "uid": uid, "email": uid, "name": "Test",
		"exp": time.Now().Add(15 * time.Minute).Unix(),
	})
}

func TestVerifyAccessTokenValid(t *testing.T) {
	claims, ok := verifyAccessToken(testAccessToken(t, "user1"), testTokenSecret, time.Now())
	if !ok || claims.UID != "user1" {
		t.Fatalf("expected valid token for user1, got %v %v", claims, ok)
	}
}

func TestVerifyAccessTokenRejects(t *testing.T) {
	now := time.Now()
	cases := map[string]string{
		"expired": signTestToken(t, map[string]any{"typ": "access", "uid": "u", "exp": now.Add(-time.Second).Unix()}),
		"no typ":  signTestToken(t, map[string]any{"uid": "u", "exp": now.Add(time.Hour).Unix()}),
		"no exp":  signTestToken(t, map[string]any{"typ": "access", "uid": "u"}),
		"garbage": "abc",
		"empty":   "",
	}
	for name, tok := range cases {
		if _, ok := verifyAccessToken(tok, testTokenSecret, now); ok {
			t.Errorf("%s: expected rejection", name)
		}
	}
	if _, ok := verifyAccessToken(testAccessToken(t, "u"), []byte("another-secret-another-secret-xx"), now); ok {
		t.Error("wrong secret: expected rejection")
	}
}

func TestBearerToken(t *testing.T) {
	r := httptest.NewRequest("GET", "/proxy/s/x", nil)
	r.Header.Set("Authorization", "Bearer abc")
	if got := bearerToken(r); got != "abc" {
		t.Errorf("header: got %q", got)
	}

	r = httptest.NewRequest("GET", "/proxy/s/x?access_token=q", nil)
	if got := bearerToken(r); got != "" {
		t.Errorf("query on plain request should be ignored, got %q", got)
	}

	r = httptest.NewRequest("GET", "/proxy/s/x?access_token=q", nil)
	r.Header.Set("Upgrade", "websocket")
	if got := bearerToken(r); got != "q" {
		t.Errorf("query on upgrade: got %q", got)
	}
}

func TestStripAccessToken(t *testing.T) {
	if got := stripAccessToken("a=1&access_token=x&b=2"); got != "a=1&b=2" {
		t.Errorf("got %q", got)
	}
	if got := stripAccessToken("location%5Bdirectory%5D=%2Fp&cursor=0"); got != "location%5Bdirectory%5D=%2Fp&cursor=0" {
		t.Errorf("queries without access_token must be untouched, got %q", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd gateway && go test -run 'TestVerifyAccessToken|TestBearerToken|TestStripAccessToken' ./...`
Expected: FAIL, undefined `verifyAccessToken`, `bearerToken`, `stripAccessToken`.

- [ ] **Step 3: Implement `token.go` and delete `cookie.go`**

`gateway/token.go`:

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// AccessClaims is the payload of an access token issued by the web server.
type AccessClaims struct {
	Typ   string `json:"typ"`
	UID   string `json:"uid"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Exp   int64  `json:"exp"`
}

func verifyAccessToken(token string, secret []byte, now time.Time) (*AccessClaims, bool) {
	lastDot := strings.LastIndex(token, ".")
	if lastDot <= 0 {
		return nil, false
	}
	payload := token[:lastDot]
	gotMac := token[lastDot+1:]

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	expectedMac := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(gotMac), []byte(expectedMac)) {
		return nil, false
	}

	jsonBytes, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, false
	}
	var claims AccessClaims
	if err := json.Unmarshal(jsonBytes, &claims); err != nil {
		return nil, false
	}
	if claims.Typ != "access" || claims.Exp == 0 || now.Unix() >= claims.Exp {
		return nil, false
	}
	return &claims, true
}

// bearerToken reads the access token from the Authorization header, or from
// the access_token query parameter on WebSocket upgrades (browsers cannot set
// headers on WebSocket connections).
func bearerToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[len("Bearer "):])
	}
	if isWebSocketUpgrade(r) {
		return r.URL.Query().Get("access_token")
	}
	return ""
}

// stripAccessToken removes access_token from a raw query so it is not
// forwarded to opencode. Queries without it are returned unchanged.
func stripAccessToken(rawQuery string) string {
	q, err := url.ParseQuery(rawQuery)
	if err != nil || !q.Has("access_token") {
		return rawQuery
	}
	q.Del("access_token")
	return q.Encode()
}
```

Run: `git rm gateway/cookie.go`

- [ ] **Step 4: Switch the proxy handler to bearer tokens**

In `gateway/gateway_proxy.go`:
- Rename the parameter: `func GatewayProxyHandler(registry *TunnelRegistry, tokenSecret []byte) http.Handler {`
- Replace the query forwarding lines

```go
		if r.URL.RawQuery != "" {
			downstream += "?" + r.URL.RawQuery
		}
```

with

```go
		if q := stripAccessToken(r.URL.RawQuery); q != "" {
			downstream += "?" + q
		}
```

- Replace the block from `// Authenticate via session cookie` through the `if !ok { ... }` that follows `verifyCookie` with:

```go
		// Authenticate via access token issued by the web server
		session, ok := verifyAccessToken(bearerToken(r), tokenSecret, time.Now())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
```

- Replace the owner check's user ID lines

```go
		userID := session.Email
		if userID == "" {
			userID = session.UID
		}
		if userID != meta.UserID {
```

with

```go
		if session.UID != meta.UserID {
```

- Add `"time"` to the imports.

In `gateway/routes_gateway.go`, rename the `cookieSecret []byte` parameter of `SetupGatewayRoutes` to `tokenSecret []byte` and pass `tokenSecret` to `GatewayProxyHandler`.

- [ ] **Step 5: Config: `TOKEN_SECRET` with `COOKIE_SECRET` fallback**

In `gateway/config.go`:
- Rename the struct field `CookieSecret []byte` to `TokenSecret []byte`.
- Replace

```go
	secretHex := os.Getenv("COOKIE_SECRET")
```

with

```go
	secretHex := os.Getenv("TOKEN_SECRET")
	if secretHex == "" {
		secretHex = os.Getenv("COOKIE_SECRET")
	}
```

- Change the two error messages to `"TOKEN_SECRET is required (32-byte hex string)"` and `"TOKEN_SECRET must be a 64-char hex string (32 bytes)"`.
- In the returned struct, rename `CookieSecret: secret,` to `TokenSecret: secret,`.

In `gateway/main.go`, change `cfg.CookieSecret` to `cfg.TokenSecret`.
In `gateway/main_test.go:244`, change `CookieSecret:` to `TokenSecret:`.
In `gateway/config_test.go`, change `cfg.CookieSecret` to `cfg.TokenSecret` (lines 41-42), rename `TestLoadConfigMissingCookieSecret` to `TestLoadConfigMissingTokenSecret` and make it unset both `TOKEN_SECRET` and `COOKIE_SECRET`, and add:

```go
func TestLoadConfigTokenSecretPreferred(t *testing.T) {
	setRequiredGatewayEnv(t)
	t.Setenv("COOKIE_SECRET", strings.Repeat("ab", 32))
	t.Setenv("TOKEN_SECRET", strings.Repeat("cd", 32))
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(cfg.TokenSecret) != strings.Repeat("cd", 32) {
		t.Errorf("expected TOKEN_SECRET to win, got %x", cfg.TokenSecret)
	}
}
```

`setRequiredGatewayEnv` stands for however the existing tests in `config_test.go` set the required env vars. Read the top of that file first and reuse the existing helper or inline the same `t.Setenv` calls. Add `"encoding/hex"` and `"strings"` imports if missing. Use the real name of the config loader (check `config.go`; the plan assumes `LoadConfig`).

- [ ] **Step 6: Update the proxy tests**

In `gateway/gateway_proxy_test.go`:
- Delete `testCookieSecret`, `testCookie` and `addTestCookie`. Replace every `GatewayProxyHandler(reg, testCookieSecret)` with `GatewayProxyHandler(reg, testTokenSecret)` and every `addTestCookie(req)` with `req.Header.Set("Authorization", "Bearer "+testAccessToken(t, "user1"))`.
- Remove imports that become unused (`crypto/hmac`, `crypto/sha256`, `encoding/base64`, `encoding/json` if only the cookie helpers used them).
- Append these tests, which follow the setup pattern of `TestGatewayProxyHTTP` (backend, `testTunnel`, `testRedisStore`, `NewTunnelRegistry`, `reg.Register`):

```go
func newAuthTestHandler(t *testing.T, backend http.Handler) (http.Handler, func()) {
	t.Helper()
	mux, cleanup := testTunnel(t, backend)
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess1", "/proj", "", mux)
	return GatewayProxyHandler(reg, testTokenSecret), cleanup
}

func TestGatewayProxyRejectsMissingToken(t *testing.T) {
	handler, cleanup := newAuthTestHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer cleanup()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/proxy/sess1/api/health", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestGatewayProxyRejectsSessionCookie(t *testing.T) {
	handler, cleanup := newAuthTestHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer cleanup()
	req := httptest.NewRequest("GET", "/proxy/sess1/api/health", nil)
	req.AddCookie(&http.Cookie{Name: "orc_session", Value: testAccessToken(t, "user1")})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestGatewayProxyRejectsOtherUser(t *testing.T) {
	handler, cleanup := newAuthTestHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer cleanup()
	req := httptest.NewRequest("GET", "/proxy/sess1/api/health", nil)
	req.Header.Set("Authorization", "Bearer "+testAccessToken(t, "user2"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestGatewayProxyStripsAccessToken(t *testing.T) {
	var gotQuery string
	handler, cleanup := newAuthTestHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer cleanup()
	req := httptest.NewRequest("GET", "/proxy/sess1/api/health?a=1&access_token=secret", nil)
	req.Header.Set("Authorization", "Bearer "+testAccessToken(t, "user1"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(gotQuery, "access_token") || !strings.Contains(gotQuery, "a=1") {
		t.Errorf("unexpected forwarded query %q", gotQuery)
	}
}
```

- [ ] **Step 7: Run gateway tests**

Run: `cd gateway && go vet ./... && go test ./...`
Expected: PASS (Docker is needed for the testcontainers Redis, as before).

- [ ] **Step 8: Commit**

```bash
git add gateway/
git commit -m "feat(gateway): authenticate /proxy with bearer access tokens instead of session cookie"
```

---

### Task 8: Helm chart

**Files:**
- Modify: `charts/opencode-rc/values.yaml`
- Modify: `charts/opencode-rc/templates/secret.yaml`
- Modify: `charts/opencode-rc/templates/web-deployment.yaml`
- Modify: `charts/opencode-rc/templates/gateway-deployment.yaml`
- Modify: `charts/opencode-rc/tests/web_deployment_test.yaml`, `charts/opencode-rc/tests/gateway_deployment_test.yaml`, `charts/opencode-rc/tests/secret_test.yaml`

**Interfaces:**
- Produces: env `TOKEN_SECRET` (both deployments, from secret key `cookie-secret`, which keeps existing `existingSecret` setups working), `ACCESS_TOKEN_TTL`, `SESSION_TTL`, and `ALLOWED_ORIGINS` (web, only when set). `COOKIE_SECURE` stays. `COOKIE_DOMAIN` and `oidc.cookieDomain` are removed.

- [ ] **Step 1: Write failing chart tests**

In `charts/opencode-rc/tests/web_deployment_test.yaml`, change the test named `reads COOKIE_SECRET from secret` so it is named `reads TOKEN_SECRET from secret` and its `name: COOKIE_SECRET` becomes `name: TOKEN_SECRET` (keep `key: cookie-secret`). Append:

```yaml
  - it: sets token TTL defaults
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: ACCESS_TOKEN_TTL
            value: "15m"
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: SESSION_TTL
            value: "7d"

  - it: sets ALLOWED_ORIGINS when configured
    set:
      auth.allowedOrigins:
        - https://a.example.com
        - https://b.example.com
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: ALLOWED_ORIGINS
            value: "https://a.example.com,https://b.example.com"

  - it: does not set COOKIE_DOMAIN
    asserts:
      - notContains:
          path: spec.template.spec.containers[0].env
          content:
            name: COOKIE_DOMAIN
          any: true
```

In `charts/opencode-rc/tests/gateway_deployment_test.yaml`, change `name: COOKIE_SECRET` to `name: TOKEN_SECRET` (line 50).

In `charts/opencode-rc/tests/secret_test.yaml`, append:

```yaml
  - it: prefers secrets.tokenSecret over secrets.cookieSecret
    set:
      secrets.tokenSecret: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
    asserts:
      - equal:
          path: stringData["cookie-secret"]
          value: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
```

(Match the indentation and top-level keys, such as `templates:`, used by the existing tests in each file.)

- [ ] **Step 2: Run to verify failure**

Run: `helm unittest charts/opencode-rc`
Expected: FAIL on the new/renamed assertions.

- [ ] **Step 3: Implement**

`charts/opencode-rc/values.yaml`:
- Remove the line `  cookieDomain: ""` under `oidc:`.
- Under `secrets:`, add `  tokenSecret: ""` above `cookieSecret`, with the comment `  # HMAC key for access tokens (64-char hex). Falls back to cookieSecret.`
- Add a new top-level block (next to `oidc:`):

```yaml
auth:
  # Access token lifetime (<int>s|m|h|d)
  accessTokenTTL: "15m"
  # Absolute login lifetime; refresh never extends it
  sessionTTL: "7d"
  # Extra browser origins allowed for return_to and CORS, besides the server
  # itself and the mobile app (capacitor://localhost, https://localhost)
  allowedOrigins: []
```

`charts/opencode-rc/templates/secret.yaml`: replace the `cookie-secret:` line with

```yaml
  cookie-secret: {{ .Values.secrets.tokenSecret | default .Values.secrets.cookieSecret | quote }}
```

`charts/opencode-rc/templates/web-deployment.yaml`:
- Rename `- name: COOKIE_SECRET` to `- name: TOKEN_SECRET` (keep its `valueFrom`).
- Delete the `{{- if .Values.oidc.cookieDomain }} ... COOKIE_DOMAIN ... {{- end }}` block.
- After the `COOKIE_SECURE` entry, add:

```yaml
            - name: ACCESS_TOKEN_TTL
              value: {{ .Values.auth.accessTokenTTL | quote }}
            - name: SESSION_TTL
              value: {{ .Values.auth.sessionTTL | quote }}
            {{- with .Values.auth.allowedOrigins }}
            - name: ALLOWED_ORIGINS
              value: {{ join "," . | quote }}
            {{- end }}
```

`charts/opencode-rc/templates/gateway-deployment.yaml`: rename `- name: COOKIE_SECRET` to `- name: TOKEN_SECRET`.

Search for other uses: `grep -rn "cookieDomain\|COOKIE_DOMAIN" charts/ e2e/ docs/ README.md`. Remove or update each hit (e.g. README values tables).

- [ ] **Step 4: Run chart tests**

Run: `helm unittest charts/opencode-rc`
Expected: PASS. If snapshot tests in `tests/__snapshot__` fail only because of the env changes, update them with `helm unittest -u charts/opencode-rc` and review the diff before committing.

- [ ] **Step 5: Commit**

```bash
git add charts/
git commit -m "feat(chart): configure bearer token secret, TTLs and allowed origins"
```

---

### Task 9: UI token handling (`auth.ts`)

**Files:**
- Create: `ui/src/server.ts` (moved from `api.ts`)
- Modify: `ui/src/api.ts`
- Create: `ui/src/auth.ts`
- Test: `ui/src/auth.test.ts`

**Interfaces:**
- `server.ts` produces (moved verbatim from `api.ts`): `loadConfig`, `isPreConfigured`, `resetConfig`, `getBaseUrl`, `setBaseUrl`, `isConfigured`, `apiUrl`. `api.ts` re-exports them with `export * from "./server"`, so existing imports and `api.test.ts` keep working.
- `auth.ts` produces:
  - `interface TokenResponse { access_token: string; refresh_token: string; expires_in: number }`
  - `hasSession(): boolean`
  - `getAccessToken(): Promise<string | null>`
  - `getCachedAccessToken(): string | null`
  - `invalidateAccessToken(): void`
  - `authFetch(url: string, init?: RequestInit): Promise<Response>`
  - `login(): void`
  - `completeLogin(): Promise<"none" | "ok" | "expired">`
  - `logout(): Promise<void>`
  - `onLoggedOut(cb: () => void): void`
  - `resetAuthState(): void` (tests only)
  - `const REFRESH_KEY = "opencode-rc-refresh"`

- [ ] **Step 1: Move server config out of `api.ts`**

Create `ui/src/server.ts` and move into it, unchanged, everything in `ui/src/api.ts` from `const STORAGE_KEY = "opencode-rc-endpoint"` through the end of `apiUrl()`. In `api.ts`, replace the moved code with:

```ts
import { apiUrl } from "./server"

export * from "./server"
```

Run: `cd ui && npx vitest run`
Expected: PASS (no behaviour change).

- [ ] **Step 2: Write the failing test**

`ui/src/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  REFRESH_KEY,
  authFetch,
  completeLogin,
  getAccessToken,
  hasSession,
  login,
  logout,
  onLoggedOut,
  resetAuthState,
} from "./auth"
import { resetConfig } from "./server"

function tokens(n: number) {
  return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900 }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  localStorage.clear()
  resetConfig()
  resetAuthState()
})

afterEach(() => vi.restoreAllMocks())

describe("completeLogin", () => {
  it("does nothing without a code", async () => {
    window.history.replaceState(null, "", "/")
    expect(await completeLogin()).toBe("none")
  })

  it("exchanges the code, stores the refresh token and strips the fragment", async () => {
    window.history.replaceState(null, "", "/s/x/#code=abc")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tokens(1)))
    expect(await completeLogin()).toBe("ok")
    expect(window.location.hash).toBe("")
    expect(window.location.pathname).toBe("/s/x/")
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1")
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/auth/token")
    expect(JSON.parse(init.body as string)).toEqual({ code: "abc" })
    expect(await getAccessToken()).toBe("access-1")
  })

  it("reports an expired code", async () => {
    window.history.replaceState(null, "", "/#code=old")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "invalid_grant" }, 400))
    expect(await completeLogin()).toBe("expired")
    expect(hasSession()).toBe(false)
  })
})

describe("getAccessToken", () => {
  it("returns null without a session", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    expect(await getAccessToken()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("refreshes once for concurrent callers", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tokens(1)))
    const [a, b] = await Promise.all([getAccessToken(), getAccessToken()])
    expect(a).toBe("access-1")
    expect(b).toBe("access-1")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1")
  })

  it("clears the session and notifies on invalid_grant", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "invalid_grant" }, 401))
    const cb = vi.fn()
    onLoggedOut(cb)
    expect(await getAccessToken()).toBeNull()
    expect(hasSession()).toBe(false)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe("authFetch", () => {
  it("adds the bearer header", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === "/auth/refresh" ? json(tokens(1)) : json({ ok: true }),
    )
    await authFetch("/api/me")
    const init = spy.mock.calls[1][1] as RequestInit
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-1")
  })

  it("refreshes and retries once on 401", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    let refreshes = 0
    let meCalls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/auth/refresh") return json(tokens(++refreshes))
      meCalls++
      return meCalls === 1 ? json({ error: "unauthorized" }, 401) : json({ ok: true })
    })
    const res = await authFetch("/api/me")
    expect(res.status).toBe(200)
    expect(refreshes).toBe(2)
    expect(meCalls).toBe(2)
  })
})

describe("login / logout", () => {
  it("login sends a relative return_to when served by the server", () => {
    window.history.replaceState(null, "", "/s/x/?a=1")
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      pathname: "/s/x/",
      search: "?a=1",
      set href(v: string) { assign(v) },
    } as Location)
    login()
    expect(assign).toHaveBeenCalledWith("/auth/start?return_to=%2Fs%2Fx%2F%3Fa%3D1")
  })

  it("login sends an absolute return_to with a configured server", () => {
    localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      get href() { return "https://localhost/#stale" },
      set href(v: string) { assign(v) },
    } as unknown as Location)
    login()
    expect(assign).toHaveBeenCalledWith(
      "https://rc.example.com/auth/start?return_to=https%3A%2F%2Flocalhost%2F",
    )
  })

  it("logout revokes and clears", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
    await logout()
    expect(hasSession()).toBe(false)
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/auth/logout")
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: "refresh-0" })
  })
})
```

The two `login` tests replace `window.location` with a getter mock. If jsdom refuses (`Cannot redefine property: location`), switch to the pattern already used in `login-screen.test.tsx` (`Object.defineProperty(window, "location", { value: ..., writable: true })`) and restore it in `afterEach`. Keep the assertions.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ui && npx vitest run src/auth.test.ts`
Expected: FAIL, cannot resolve `./auth`.

- [ ] **Step 4: Implement**

`ui/src/auth.ts`:

```ts
import { apiUrl, getBaseUrl } from "./server"

export const REFRESH_KEY = "opencode-rc-refresh"
const EARLY_REFRESH_MS = 30_000

export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

let access: { token: string; expiresAt: number } | null = null
let inflight: Promise<string | null> | null = null
let loggedOutListener: (() => void) | null = null

function readRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

function writeRefresh(token: string | null) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token)
    else localStorage.removeItem(REFRESH_KEY)
  } catch {}
}

function save(res: TokenResponse) {
  access = { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 }
  writeRefresh(res.refresh_token)
}

function clear() {
  access = null
  writeRefresh(null)
}

function fresh(): string | null {
  return access && access.expiresAt - Date.now() > EARLY_REFRESH_MS ? access.token : null
}

function postJson(path: string, body: unknown) {
  return fetch(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function refreshNow(): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const current = fresh()
    if (current) return current
    // Re-read: another tab may have rotated the refresh token while we waited for the lock.
    const refreshToken = readRefresh()
    if (!refreshToken) return null
    const res = await postJson("/auth/refresh", { refresh_token: refreshToken })
    if (res.status === 400 || res.status === 401) {
      clear()
      loggedOutListener?.()
      return null
    }
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
    const body = (await res.json()) as TokenResponse
    save(body)
    return body.access_token
  }
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  return locks?.request ? locks.request("orc-refresh", run) : run()
}

export function hasSession(): boolean {
  return !!readRefresh()
}

export function getCachedAccessToken(): string | null {
  return access && access.expiresAt > Date.now() ? access.token : null
}

export function invalidateAccessToken(): void {
  access = null
}

export function getAccessToken(): Promise<string | null> {
  const current = fresh()
  if (current) return Promise.resolve(current)
  inflight ??= refreshNow().finally(() => {
    inflight = null
  })
  return inflight
}

export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string | null) => {
    const headers = new Headers(init.headers)
    if (token) headers.set("authorization", `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  }
  const res = await send(await getAccessToken())
  if (res.status !== 401 || !hasSession()) return res
  invalidateAccessToken()
  return send(await getAccessToken())
}

export function login(): void {
  // Served by the server itself: return to a path. Otherwise (the app): absolute URL.
  const returnTo = getBaseUrl()
    ? window.location.href.split("#")[0]
    : window.location.pathname + window.location.search
  window.location.href = apiUrl(`/auth/start?return_to=${encodeURIComponent(returnTo)}`)
}

export async function completeLogin(): Promise<"none" | "ok" | "expired"> {
  const match = window.location.hash.match(/(?:^#|&)code=([^&]+)/)
  if (!match) return "none"
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
  try {
    const res = await postJson("/auth/token", { code: decodeURIComponent(match[1]) })
    if (!res.ok) return "expired"
    save((await res.json()) as TokenResponse)
    return "ok"
  } catch {
    return "expired"
  }
}

export async function logout(): Promise<void> {
  const refreshToken = readRefresh()
  clear()
  if (refreshToken) {
    await postJson("/auth/logout", { refresh_token: refreshToken }).catch(() => undefined)
  }
}

export function onLoggedOut(cb: () => void): void {
  loggedOutListener = cb
}

export function resetAuthState(): void {
  access = null
  inflight = null
  loggedOutListener = null
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && npx vitest run src/auth.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/src/server.ts ui/src/api.ts ui/src/auth.ts ui/src/auth.test.ts
git commit -m "feat(ui): add bearer token handling with refresh and cross-tab lock"
```

---

### Task 10: UI screens use tokens

**Files:**
- Modify: `ui/src/api.ts` (`fetchMe`, `fetchSessions`)
- Modify: `ui/src/api.test.ts`
- Modify: `ui/src/login-screen.tsx`, `ui/src/login-screen.test.tsx`
- Modify: `ui/src/user-bar.tsx`
- Modify: `ui/src/entry.tsx` (startup and `App` only; the wrappers change in Task 11)

**Interfaces:**
- Consumes: `authFetch`, `hasSession`, `login`, `logout`, `completeLogin`, `onLoggedOut` (Task 9).
- Produces: `LoginScreen` prop `expired?: boolean`.

- [ ] **Step 1: Update tests first**

In `ui/src/api.test.ts`, for the `fetchMe` / `fetchSessions` tests:
- Before each test that expects a user or sessions, add `localStorage.setItem("opencode-rc-refresh", "r")` and mock fetch so that `"/auth/refresh"` (or `"https://…/auth/refresh"` in base-URL tests) returns `{access_token:"a",refresh_token:"r2",expires_in:900}`, while the other URL returns the existing response.
- Add:

```ts
  it("fetchMe returns null without a session and makes no request", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    expect(await fetchMe()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
```

- Add `resetAuthState()` (imported from `./auth`) to the file's `beforeEach`.

In `ui/src/login-screen.test.tsx`, replace the tests that assert `window.location.href` becomes `/auth/start` or `https://rc.example.com/auth/start` with ones that assert it starts with `/auth/start?return_to=` or `https://rc.example.com/auth/start?return_to=` (the button now calls `login()`). Add:

```tsx
  it("shows the expired notice", () => {
    render(() => <LoginScreen onSettings={() => {}} expired />)
    expect(screen.getByText("Sign-in expired, try again")).toBeTruthy()
  })
```

Run: `cd ui && npx vitest run src/api.test.ts src/login-screen.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Implement `api.ts`**

Replace `fetchMe` and `fetchSessions` in `ui/src/api.ts` with:

```ts
export async function fetchMe(): Promise<UserInfo | null> {
  if (!hasSession()) return null
  const res = await authFetch(apiUrl("/api/me"))
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`/api/me failed: ${res.status}`)
  return res.json()
}

export async function fetchSessions(): Promise<DevSession[]> {
  const res = await authFetch(apiUrl("/gateway/sessions"))
  if (!res.ok) return []
  return res.json()
}
```

and add `import { authFetch, hasSession } from "./auth"` at the top.

- [ ] **Step 3: Implement the login screen**

In `ui/src/login-screen.tsx`:
- Change the imports to `import { isPreConfigured } from "./api"` and `import { login } from "./auth"`.
- Change the component signature to `export const LoginScreen: Component<{ onSettings: () => void; expired?: boolean }> = (props) => {`.
- Delete `handleLogin` and use `onClick={login}` on the sign-in button.
- Directly under the `<p ...>Sign in to access your dev sessions.</p>` paragraph, add:

```tsx
        <Show when={props.expired}>
          <p class="text-13-regular text-v2-text-text-critical mb-4">Sign-in expired, try again</p>
        </Show>
```

(If `text-v2-text-text-critical` doesn't exist in the theme, use the class the config screen uses for its error text; check `config-screen.tsx`.)

- [ ] **Step 4: Implement the user bar logout**

In `ui/src/user-bar.tsx`, change the imports to `import { isPreConfigured, type UserInfo } from "./api"` and `import { logout } from "./auth"`, and replace the sign-out `onClick` with:

```tsx
          onClick={async () => {
            await logout()
            window.location.href = "/"
          }}
```

- [ ] **Step 5: Implement startup**

In `ui/src/entry.tsx`:
- Import `completeLogin` and `onLoggedOut` from `"./auth"`.
- Change `function App()` to `function App(props: { loginExpired: boolean })`, and right after `createResource(fetchMe)` add:

```tsx
  onLoggedOut(() => refetchUser())
```

- Pass the flag: `<LoginScreen onSettings={() => setShowConfig(true)} expired={props.loginExpired} />`.
- Replace the bootstrap at the bottom with:

```tsx
const root = document.getElementById("root")
if (root) {
  loadConfig()
    .then(() => completeLogin())
    .then((result) => render(() => <App loginExpired={result === "expired"} />, root))
}
```

- [ ] **Step 6: Run UI tests**

Run: `cd ui && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/api.ts ui/src/api.test.ts ui/src/login-screen.tsx ui/src/login-screen.test.tsx ui/src/user-bar.tsx ui/src/entry.tsx
git commit -m "feat(ui): log in, log out and load user data with bearer tokens"
```

---

### Task 11: UI proxy rewriting, WebSocket token, drop CapacitorHttp

**Files:**
- Create: `ui/src/proxy-fetch.ts`
- Test: `ui/src/proxy-fetch.test.ts`
- Modify: `ui/src/entry.tsx`
- Delete: `ui/src/fix-response.ts`, `ui/src/fix-response.test.ts`
- Modify: `ui/capacitor.config.ts`, `ui/vite.config.ts`
- Regenerate: `ui/ios/App/App/capacitor.config.json` and `ui/android/app/src/main/assets/capacitor.config.json` via `npx cap sync` (commit only the files git tracks)

**Interfaces:**
- Consumes: `getAccessToken`, `getCachedAccessToken`, `invalidateAccessToken` (Task 9).
- Produces:
  - `interface ProxyOptions { pageOrigin: string; serverOrigin: string; sessionId: string }`
  - `proxyTarget(url: string, opts: ProxyOptions): string | null`: the `/proxy/<id>` URL for opencode API calls; `null` for opencode-rc's own endpoints and other hosts.
  - `proxySocketUrl(url: string, opts: ProxyOptions, token: string | null): string | null`
  - `installProxyFetch(opts: ProxyOptions & { getToken: () => Promise<string | null>; invalidate: () => void }): void`
  - `installProxyWebSocket(opts: ProxyOptions & { getCachedToken: () => string | null; warmToken: () => void }): void`

- [ ] **Step 1: Write the failing test**

`ui/src/proxy-fetch.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest"
import { proxyTarget, proxySocketUrl, installProxyFetch } from "./proxy-fetch"

const app = { pageOrigin: "https://localhost", serverOrigin: "https://rc.example.com", sessionId: "alice-dev" }
const web = { pageOrigin: "https://rc.example.com", serverOrigin: "https://rc.example.com", sessionId: "alice-dev" }

const realFetch = globalThis.fetch
afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = realFetch
})

describe("proxyTarget", () => {
  it("prefixes opencode paths on the server origin", () => {
    expect(proxyTarget("https://rc.example.com/session?x=1", web)).toBe(
      "https://rc.example.com/proxy/alice-dev/session?x=1",
    )
  })

  it("moves page-origin requests to the server (app)", () => {
    expect(proxyTarget("https://localhost/global/event", app)).toBe(
      "https://rc.example.com/proxy/alice-dev/global/event",
    )
    expect(proxyTarget("/api/session", app)).toBe("https://rc.example.com/proxy/alice-dev/api/session")
  })

  it("keeps an existing proxy prefix and collapses duplicate slashes", () => {
    expect(proxyTarget("https://rc.example.com/proxy/alice-dev//pty/1/connect", web)).toBe(
      "https://rc.example.com/proxy/alice-dev/pty/1/connect",
    )
  })

  it("leaves opencode-rc endpoints and other hosts alone", () => {
    expect(proxyTarget("https://rc.example.com/api/me", web)).toBeNull()
    expect(proxyTarget("https://rc.example.com/auth/refresh", web)).toBeNull()
    expect(proxyTarget("https://rc.example.com/gateway/sessions", web)).toBeNull()
    expect(proxyTarget("https://rc.example.com/healthz", web)).toBeNull()
    expect(proxyTarget("https://localhost/assets/app.js", app)).toBeNull()
    expect(proxyTarget("https://models.dev/api.json", web)).toBeNull()
  })

  it("does not treat /api/media as /api/me", () => {
    expect(proxyTarget("https://rc.example.com/api/media", web)).toBe(
      "https://rc.example.com/proxy/alice-dev/api/media",
    )
  })
})

describe("proxySocketUrl", () => {
  it("rewrites terminal sockets and adds the token", () => {
    expect(
      proxySocketUrl("wss://rc.example.com/proxy/alice-dev//pty/p1/connect?cursor=0", web, "tok"),
    ).toBe("wss://rc.example.com/proxy/alice-dev/pty/p1/connect?cursor=0&access_token=tok")
  })

  it("maps the app's page origin to the server", () => {
    expect(proxySocketUrl("wss://localhost/pty/p1/connect", app, "tok")).toBe(
      "wss://rc.example.com/proxy/alice-dev/pty/p1/connect?access_token=tok",
    )
  })

  it("ignores other hosts", () => {
    expect(proxySocketUrl("wss://other.example.com/x", web, "tok")).toBeNull()
  })
})

describe("installProxyFetch", () => {
  it("adds the bearer header and retries once on 401", async () => {
    const calls: Request[] = []
    let status = 401
    const original = vi.fn(async (req: Request) => {
      calls.push(req)
      const res = new Response("{}", { status })
      status = 200
      return res
    })
    globalThis.fetch = original as unknown as typeof fetch
    let n = 0
    const invalidate = vi.fn()
    installProxyFetch({ ...web, getToken: async () => `tok-${++n}`, invalidate })

    const res = await fetch("https://rc.example.com/session", { method: "POST", body: "{\"a\":1}" })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("https://rc.example.com/proxy/alice-dev/session")
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok-1")
    expect(calls[1].headers.get("authorization")).toBe("Bearer tok-2")
    expect(await calls[1].text()).toBe("{\"a\":1}")
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it("passes other requests through untouched", async () => {
    const original = vi.fn(async () => new Response("ok"))
    globalThis.fetch = original as unknown as typeof fetch
    installProxyFetch({ ...web, getToken: async () => "tok", invalidate: () => {} })
    await fetch("https://rc.example.com/api/me")
    expect(original).toHaveBeenCalledWith("https://rc.example.com/api/me", undefined)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/proxy-fetch.test.ts`
Expected: FAIL, cannot resolve `./proxy-fetch`.

- [ ] **Step 3: Implement**

`ui/src/proxy-fetch.ts`:

```ts
export interface ProxyOptions {
  pageOrigin: string
  serverOrigin: string
  sessionId: string
}

// opencode-rc's own endpoints: never rewritten to the session proxy.
const RC_PREFIXES = ["/auth/", "/gateway/", "/assets/"]
const RC_PATHS = ["/healthz", "/api/me"]

export function proxyTarget(input: string, opts: ProxyOptions): string | null {
  let url: URL
  try {
    url = new URL(input, opts.pageOrigin)
  } catch {
    return null
  }
  if (url.origin !== opts.pageOrigin && url.origin !== opts.serverOrigin) return null
  if (RC_PATHS.includes(url.pathname) || RC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    return null
  }
  const prefix = `/proxy/${encodeURIComponent(opts.sessionId)}`
  let path = url.pathname.replace(/\/{2,}/g, "/")
  if (path !== prefix && !path.startsWith(`${prefix}/`)) path = `${prefix}${path}`
  return `${opts.serverOrigin}${path}${url.search}`
}

export function proxySocketUrl(input: string, opts: ProxyOptions, token: string | null): string | null {
  let url: URL
  try {
    url = new URL(input, opts.pageOrigin)
  } catch {
    return null
  }
  const httpUrl = new URL(url.href)
  if (url.protocol === "wss:") httpUrl.protocol = "https:"
  else if (url.protocol === "ws:") httpUrl.protocol = "http:"
  const target = proxyTarget(httpUrl.href, opts)
  if (!target) return null
  const out = new URL(target)
  out.protocol = out.protocol === "https:" ? "wss:" : "ws:"
  if (token) out.searchParams.set("access_token", token)
  return out.href
}

export function installProxyFetch(
  opts: ProxyOptions & { getToken: () => Promise<string | null>; invalidate: () => void },
): void {
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const target = proxyTarget(raw, opts)
    if (!target) return original(input, init)

    const base = new Request(input instanceof Request ? input : new URL(raw, opts.pageOrigin), init)
    const request = new Request(target, base)
    const send = async () => {
      const req = request.clone()
      const token = await opts.getToken()
      if (token) req.headers.set("authorization", `Bearer ${token}`)
      return original(req)
    }
    const res = await send()
    if (res.status !== 401) return res
    opts.invalidate()
    return send()
  }
}

export function installProxyWebSocket(
  opts: ProxyOptions & { getCachedToken: () => string | null; warmToken: () => void },
): void {
  const Native = globalThis.WebSocket
  class ProxiedWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      const token = opts.getCachedToken()
      // No valid token cached: start a refresh so the terminal's reconnect gets one.
      if (!token) opts.warmToken()
      super(proxySocketUrl(String(url), opts, token) ?? url, protocols)
    }
  }
  globalThis.WebSocket = ProxiedWebSocket as typeof WebSocket
}
```

Run: `cd ui && npx vitest run src/proxy-fetch.test.ts`
Expected: PASS (12 tests). If jsdom's `Request` rejects `new Request(target, base)` with a streaming body, pass `duplex: "half"` through a cast (`{ ...init, duplex: "half" } as RequestInit`) when building `base`. Keep the retry assertions.

- [ ] **Step 4: Use it in `entry.tsx`**

In `ui/src/entry.tsx`, inside the `user() && sessionId` branch:
- Delete everything from the `// Patch globalThis.fetch to rewrite OpenCode API paths through the session proxy.` comment through the end of the `globalThis.fetch = async (input, init) => { ... }` assignment.
- Replace `const proxyUrl = \`${serverOrigin}${sessionPrefix}/\`` with `const proxyUrl = \`${serverOrigin}/proxy/${sessionId}/\``, keeping `sessionPrefix` (still used by the router).
- Insert after the `proxyUrl` line:

```tsx
          const proxyOpts = { pageOrigin: location.origin, serverOrigin, sessionId }
          installProxyFetch({ ...proxyOpts, getToken: getAccessToken, invalidate: invalidateAccessToken })
          installProxyWebSocket({
            ...proxyOpts,
            getCachedToken: getCachedAccessToken,
            warmToken: () => void getAccessToken(),
          })
```

- Update the imports: remove `import { dropBogusContentLength } from "./fix-response"`; add `import { installProxyFetch, installProxyWebSocket } from "./proxy-fetch"` and `getAccessToken, getCachedAccessToken, invalidateAccessToken` to the `./auth` import.

Delete the CapacitorHttp workarounds:

```bash
git rm ui/src/fix-response.ts ui/src/fix-response.test.ts
```

- [ ] **Step 5: Disable CapacitorHttp and update the dev proxy**

`ui/capacitor.config.ts`: remove the `plugins: { CapacitorHttp: { enabled: true } }` block, so the object is:

```ts
const config: CapacitorConfig = {
  appId: "com.opencode.rc",
  appName: "OpenCode RC",
  webDir: "dist",
  server: {
    androidScheme: "https",
    allowNavigation: ["*"],
  },
}
```

`ui/vite.config.ts`: in `server.proxy`, replace `"/s": "http://localhost:12029",` with `"/proxy": { target: "http://localhost:12029", ws: true },`.

- [ ] **Step 6: Build and sync**

Run: `cd ui && bun run build && npx cap sync`
Expected: build succeeds; `git status` shows `ui/ios/App/App/capacitor.config.json` without the `CapacitorHttp` plugin. Stage only tracked files that changed (`git status --short ui/ios ui/android`).

- [ ] **Step 7: Run all UI tests**

Run: `cd ui && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src ui/capacitor.config.ts ui/vite.config.ts ui/ios/App/App/capacitor.config.json
git commit -m "feat(ui): route opencode calls to /proxy/:id with bearer tokens, drop CapacitorHttp"
```

---

### Task 12: e2e tests

**Files:**
- Modify: `e2e/e2e.test.ts`
- Modify: `e2e/playwright/web-ui.spec.ts`
- Modify: `e2e/playwright/golden-path.spec.ts` (only if it relies on removed behaviour; see Step 4)

**Interfaces:**
- Consumes: the HTTP API from Tasks 4-6.
- Produces (test-local): `class TokenSession { access: string; refresh: string; fetch(url, init?): Promise<Response> }` and `loginAs(sub: string): Promise<TokenSession>`.

- [ ] **Step 1: Replace the cookie jar with a token session**

In `e2e/e2e.test.ts`, delete `class CookieJar` and `loginAs`, and add:

```ts
class TokenSession {
  constructor(public access: string, public refresh: string) {}

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.access}`);
    return fetch(url, { ...init, headers, redirect: "manual" });
  }
}

function cookieHeader(res: Response): string {
  return (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${WEB_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loginCode(sub: string): Promise<string> {
  const startRes = await fetch(`${WEB_URL}/auth/start?return_to=%2F`, { redirect: "manual" });
  const cookies = cookieHeader(startRes);
  const url = new URL(startRes.headers.get("location")!);

  const callbackRes = await fetch(`${OIDC_URL}/authorize/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      sub,
      client_id: OIDC_CLIENT_ID,
      redirect_uri: url.searchParams.get("redirect_uri")!,
      state: url.searchParams.get("state")!,
      nonce: "",
      scope: "openid email profile",
      code_challenge: "",
      code_challenge_method: "",
    }),
    redirect: "manual",
  });
  const webCallback = await fetch(callbackRes.headers.get("location")!, {
    headers: { cookie: cookies },
    redirect: "manual",
  });
  expect(webCallback.status).toBe(302);
  const landing = new URL(webCallback.headers.get("location")!, WEB_URL);
  const code = new URLSearchParams(landing.hash.slice(1)).get("code");
  expect(code).toBeTruthy();
  return code!;
}

async function loginAs(sub: string): Promise<TokenSession> {
  const res = await postJson("/auth/token", { code: await loginCode(sub) });
  expect(res.status).toBe(200);
  const body = await res.json();
  return new TokenSession(body.access_token, body.refresh_token);
}
```

- [ ] **Step 2: Update the existing tests**

Apply these mechanical changes across the file:
- Every `const jar = new CookieJar();` / `aliceJar` / `bobJar` declaration becomes `let jar: TokenSession;` (and `let aliceJar: TokenSession; let bobJar: TokenSession;`), and each `await loginAs(jar, "userN")` in a `beforeAll` becomes `jar = await loginAs("userN")`.
- Every `${WEB_URL}/s/${SESSION_ID}/` API path becomes `${WEB_URL}/proxy/${SESSION_ID}/`, and `/s/nonexistent-session/api/health` becomes `/proxy/nonexistent-session/api/health`.
- In the first describe block, replace the two tests `OIDC login flow sets session cookie` and `dashboard accessible with session cookie` with:

```ts
  it("OIDC login flow returns tokens", async () => {
    jar = await loginAs("user1");
    expect(jar.access).toContain(".");
    expect(jar.refresh.length).toBeGreaterThan(20);
  });
```

and declare `let jar: TokenSession;` at the top of that describe block.
- In "auth edge cases", replace `unauthenticated session proxy redirects to login` with:

```ts
  it("unauthenticated session proxy returns 401", async () => {
    const res = await fetch(`${WEB_URL}/proxy/${SESSION_ID}/api/health`);
    expect(res.status).toBe(401);
  });
```

and replace `logout clears session and redirects` with:

```ts
  it("logout revokes the refresh token", async () => {
    const session = await loginAs("user1");
    const out = await postJson("/auth/logout", { refresh_token: session.refresh });
    expect(out.status).toBe(204);
    const res = await postJson("/auth/refresh", { refresh_token: session.refresh });
    expect(res.status).toBe(401);
  });

  it("refresh rotates and tolerates a concurrent reuse", async () => {
    const session = await loginAs("user1");
    const a = await (await postJson("/auth/refresh", { refresh_token: session.refresh })).json();
    const b = await (await postJson("/auth/refresh", { refresh_token: session.refresh })).json();
    expect(a.refresh_token).not.toBe(session.refresh);
    expect(b.refresh_token).toBe(a.refresh_token);
    const me = await new TokenSession(a.access_token, a.refresh_token).fetch(`${WEB_URL}/api/me`);
    expect(me.status).toBe(200);
  });

  it("login code works only once", async () => {
    const code = await loginCode("user1");
    expect((await postJson("/auth/token", { code })).status).toBe(200);
    const again = await postJson("/auth/token", { code });
    expect(again.status).toBe(400);
  });

  it("CORS preflight allows the mobile app origin", async () => {
    const res = await fetch(`${WEB_URL}/api/me`, {
      method: "OPTIONS",
      headers: {
        origin: "capacitor://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
  });
```

- In "web UI serving", replace both tests with:

```ts
  it("session route serves the SPA without auth", async () => {
    const res = await fetch(`${WEB_URL}/s/${SESSION_ID}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("<html");
  });
```

(its `beforeAll` no longer needs to log in; keep the `waitFor`).

- [ ] **Step 3: Add the terminal WebSocket round trip**

Append:

```ts
describe("terminal WebSocket through /proxy", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("web", `${WEB_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("echoes a command through web, gateway and tunnel", async () => {
    const created = await jar.fetch(`${WEB_URL}/proxy/${SESSION_ID}/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(200);
    const pty = await created.json();
    expect(pty.id).toBeTruthy();

    const wsUrl =
      WEB_URL.replace(/^http/, "ws") +
      `/proxy/${SESSION_ID}/pty/${pty.id}/connect?cursor=0&access_token=${encodeURIComponent(jar.access)}`;
    const output = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      let text = "";
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`no echo within 15s, got: ${text.slice(-200)}`));
      }, 15_000);
      ws.onopen = () => ws.send("echo e2e-ws-$((40+2))\n");
      ws.onmessage = (e) => {
        text += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
        if (text.includes("e2e-ws-42")) {
          clearTimeout(timer);
          ws.close();
          resolve(text);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket error"));
      };
    });
    expect(output).toContain("e2e-ws-42");
  });

  it("rejects a WebSocket without a token", async () => {
    // fetch() cannot send Upgrade/Connection headers, so attempt a real WebSocket.
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(WEB_URL.replace(/^http/, "ws") + `/proxy/${SESSION_ID}/pty/x/connect`);
      ws.onopen = () => {
        ws.close();
        resolve(false);
      };
      ws.onerror = () => resolve(true);
    });
    expect(failed).toBe(true);
  });
});
```

The shell arithmetic makes `e2e-ws-42` appear only in the command's output, not in the echoed keystrokes. If the dev-machine Node has no global `WebSocket` (Node < 22), import `WebSocket` from the `ws` package, which the CLI already depends on (add it to `e2e/package.json` devDependencies with npm, since `e2e/` uses `package-lock.json`). If opencode's pty endpoint needs a body, copy what the opencode app sends (search `pty.create` in `vendor/opencode/packages/app/src`).

- [ ] **Step 4: Update Playwright**

In `e2e/playwright/web-ui.spec.ts`:
- Delete the test `bob gets not found for alice's session` (the SPA route now always returns 200; isolation is covered by the vitest test `bob cannot proxy to alice's session`).
- Append:

```ts
test.describe("token session", () => {
  test("reload keeps the user logged in", async ({ page }) => {
    await loginAs(page, "Alice");
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
    await page.reload();
    await expect(page.locator("h1", { hasText: "Sessions" })).toBeVisible();
  });

  test("login lands back on the page it started from", async ({ page }) => {
    await page.goto("/s/alice-dev/");
    await page.waitForSelector("text=Sign in with OIDC");
    await page.locator("button", { hasText: "Sign in with OIDC" }).click();
    await page.waitForURL("**/authorize**");
    await page.locator("button.user-card", { hasText: "Alice" }).click();
    await page.waitForURL(/\/s\/alice-dev\//);
    expect(page.url()).not.toContain("#code=");
  });
});
```

In `golden-path.spec.ts`, the flow is unchanged. Run it; only edit it if it fails because of removed behaviour (e.g. a check on cookies).

- [ ] **Step 5: Run the full e2e suite**

Run: `./e2e/run.sh`
Expected: all vitest and Playwright tests pass. On failure, inspect with `./e2e/run.sh --no-teardown` and `kubectl --context kind-opencode-rc-e2e logs deploy/opencode-rc-web`.

- [ ] **Step 6: Commit**

```bash
git add e2e/
git commit -m "test(e2e): cover bearer token login, refresh, CORS and terminal WebSocket"
```

---

### Task 13: Early-risk checks, manual app test, versions

**Files:**
- Possibly modify: `web/src/auth.ts` (iOS redirect fallback), `ui/src/*` (non-fetch URLs)
- Modify: version files per the repo's `check-versions` skill
- Modify: `docs/ios-app.md` (auth section)

- [ ] **Step 1: Audit server URLs loaded without fetch**

Run:

```bash
cd vendor/opencode/packages/app/src
grep -rn "window.open(\|\.src = \|src={\|href={\|new EventSource(\|download=" --include=*.tsx --include=*.ts . | grep -v test | grep -iv "https://\|mailto:" | head -50
```

For each hit that builds a URL from the server/SDK base URL (i.e. would hit `/proxy/:id/...` without a header), note it. Expected handling:
- File/image previews that use `src=` on server URLs: fetch through `fetch` (which the wrapper authenticates) and use `URL.createObjectURL`, or add the token as `access_token` in the URL. If a change is needed inside `vendor/opencode`, stop and report it instead of patching the submodule.
- Record the findings, even if there are none, in the PR description.

- [ ] **Step 2: Android emulator test**

Rebuild and install as in the investigation (JDK 21 from mise, emulator started with `-gpu swangle_indirect -memory 4096`):

```bash
cd ui && bun run build && npx cap sync android
cd android && JAVA_HOME=~/.local/share/mise/installs/java/21.0.2 ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug -q
~/Android/Sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Deploy the new images to the dev cluster first (`kind-opencode-rc-dev`: build with skaffold, `kind load docker-image`, `helm upgrade --reuse-values` with new tags, as done on 2026-09-24).

Verify in the app:
1. Set the server URL and sign in. After the IdP, the app lands on `https://localhost/` (not the server), logged in.
2. Open the session. The project list shows the project.
3. Send a prompt. The reply appears.
4. Post a message from outside (`curl` with a token to `/proxy/<id>/session/<sid>/prompt_async`). It appears **without reload** (live events now stream).
5. Open a terminal and run `echo hi`. The output appears.
6. Kill and restart the app. It is still logged in (refresh token).

- [ ] **Step 3: iOS redirect check (needs a Mac)**

Hand this to the user. They should build from the `releases/ios` branch after CI and check that login returns to `capacitor://localhost/#code=…` and the app is logged in. If WKWebView does not follow the 302 to `capacitor://`, change the end of `/auth/callback` in `web/src/auth.ts` so that, for non-http(s) `return_to` values, it returns

```ts
    return c.html(
      `<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(`${returnTo}#code=${encodeURIComponent(loginCode)}`)})</script>`,
    );
```

instead of `c.redirect(...)`, and add an auth test asserting the HTML contains the `location.replace` target for `capacitor://localhost/`.

- [ ] **Step 4: Docs**

In `docs/ios-app.md`, replace the sentence "OIDC auth works unchanged because the WebView follows the same cookie-based redirect flow as a regular browser." with:

"Login runs inside the WebView: the app sends the user to `/auth/start?return_to=capacitor://localhost/`, and after the IdP the server redirects back with a one-time code that the app exchanges for an access token (15 min) and a refresh token (stored in `localStorage`, valid 7 days). API calls use `Authorization: Bearer`, so CapacitorHttp is not used."

- [ ] **Step 5: Bump versions**

Use the repo's `check-versions` skill (`.claude/skills/check-versions`) to decide the bumps. Expected: web minor, gateway minor, chart minor, ui minor. The auth change is breaking for any external client using the cookie, so call it out in the chart's release notes if the repo keeps any.

- [ ] **Step 6: Full local verification**

Run: `make unit-test && ./e2e/run.sh`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A docs/ios-app.md web/package.json gateway/VERSION charts/opencode-rc/Chart.yaml ui/package.json
git commit -m "chore: bump versions for bearer token auth"
```

(Adjust the file list to what the check-versions skill changed. Do not push without the user's explicit instruction.)
