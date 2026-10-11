import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
import { FEATURES, parseConfig, type FeatureName } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { FEATURE_GUARDS, featureGuards, plainPath, v1Guards } from "./feature-guards.js";

type Guard = MiddlewareHandler<ProxyEnv>;

const off = parseConfig({ features: { uploads: { enabled: false } } });
const on = parseConfig({});
// A guard table with no guard except the given ones.
const guards = (only: Partial<Record<FeatureName, Guard>>) =>
  ({ ...Object.fromEntries(FEATURES.map((name) => [name, null])), ...only }) as Record<FeatureName, Guard | null>;

function makeApp(guard: Guard) {
  const app = new Hono<ProxyEnv>();
  app.all("/proxy/:sessionId/*", guard, (c) => c.text("forwarded"));
  return app;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("FEATURE_GUARDS", () => {
  it("has an entry for every feature", () => {
    expect(Object.keys(FEATURE_GUARDS).sort()).toEqual([...FEATURES].sort());
  });
});

describe("featureGuards", () => {
  it("runs the guard of a disabled feature", async () => {
    const blocked: Guard = async (c) => c.text("blocked", 403);
    const res = await makeApp(featureGuards(off, guards({ uploads: blocked }))).request("/proxy/s/x", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("blocked");
  });

  it("passes through when the feature is enabled", async () => {
    const blocked: Guard = async (c) => c.text("blocked", 403);
    const res = await makeApp(featureGuards(on, guards({ uploads: blocked }))).request("/proxy/s/x", { method: "POST" });
    expect(await res.text()).toBe("forwarded");
  });

  it("passes through a disabled feature without a guard, with no path check", async () => {
    const res = await makeApp(featureGuards(off, guards({}))).request("/proxy/s/a%5Cb", { method: "POST" });
    expect(await res.text()).toBe("forwarded");
  });

  it("checks the path before any active guard runs", async () => {
    const guard = vi.fn<Guard>(async (_c, next) => {
      await next();
    });
    const res = await makeApp(featureGuards(off, guards({ uploads: guard }))).request("/proxy/s/a%5Cb", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unsupported characters in path");
    expect(guard).not.toHaveBeenCalled();
  });

  it("forwards when the active guards let the request through", async () => {
    const pass: Guard = async (_c, next) => {
      await next();
    };
    const res = await makeApp(featureGuards(off, guards({ uploads: pass }))).request("/proxy/s/x", { method: "POST" });
    expect(await res.text()).toBe("forwarded");
  });
});

describe("plainPath", () => {
  // Bun leaves req.url relative when the Host header is malformed; a Request cannot carry
  // one, so the check is called with a minimal context.
  it("rejects a mutating request whose raw url cannot be parsed", async () => {
    const next = vi.fn();
    const c = {
      req: { method: "POST", raw: { url: "/proxy/alice-dev/session/ses_1/message" } },
      get: () => "alice@example.com",
      text: (body: string, status: number) => new Response(body, { status }),
    };
    const res = (await plainPath(c as never, next)) as Response;
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unsupported characters in path");
    expect(next).not.toHaveBeenCalled();
  });
});

describe("v1Guards", () => {
  const app = () => makeApp(v1Guards(on));
  const req = (method: string, path: string) => app().request(`/proxy/s${path}`, { method });

  it("passes legacy 1.x paths", async () => {
    expect((await req("GET", "/session")).status).toBe(200);
  });
  it("passes a route in 1.18's table", async () => {
    expect((await req("GET", "/api/session/abc/message")).status).toBe(200);
  });
  it("rejects a 2.x-only route hidden behind an encoded ? and backslashes", async () => {
    const res = await app().request(new Request("http://localhost/proxy/s/api/session%3f%5c..%5cexperimental%5cfs%5cwrite"));
    expect(res.status).toBe(400);
  });
  it("rejects routes 1.18 does not have", async () => {
    expect((await req("POST", "/api/experimental/fs/write")).status).toBe(403);
    expect((await req("POST", "/api/shell")).status).toBe(403);
  });
  it("canonicalizes case", async () => {
    expect((await req("GET", "/API/Pty")).status).toBe(200);
  });
  it("rejects undecodable paths", async () => {
    expect((await req("GET", "/api/%zz")).status).toBe(400);
  });
  it("still applies the guards of disabled features", async () => {
    const cfg = parseConfig({ features: { terminal: { enabled: false } } });
    const res = await makeApp(v1Guards(cfg)).request("/proxy/s/api/pty", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("not available through opencode-rc");
  });
});
