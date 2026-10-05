import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
import { FEATURES } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { FEATURE_GUARDS, featureGuards, plainPath } from "./feature-guards.js";

type Guard = MiddlewareHandler<ProxyEnv>;

const off = { features: { uploads: { enabled: false }, terminal: { enabled: true } } };
const on = { features: { uploads: { enabled: true }, terminal: { enabled: true } } };

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
    const res = await makeApp(featureGuards(off, { uploads: blocked, terminal: null })).request("/proxy/s/x", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("blocked");
  });

  it("passes through when the feature is enabled", async () => {
    const blocked: Guard = async (c) => c.text("blocked", 403);
    const res = await makeApp(featureGuards(on, { uploads: blocked, terminal: null })).request("/proxy/s/x", { method: "POST" });
    expect(await res.text()).toBe("forwarded");
  });

  it("passes through a disabled feature without a guard, with no path check", async () => {
    const res = await makeApp(featureGuards(off, { uploads: null, terminal: null })).request("/proxy/s/a%5Cb", { method: "POST" });
    expect(await res.text()).toBe("forwarded");
  });

  it("checks the path before any active guard runs", async () => {
    const guard = vi.fn<Guard>(async (_c, next) => {
      await next();
    });
    const res = await makeApp(featureGuards(off, { uploads: guard, terminal: null })).request("/proxy/s/a%5Cb", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unsupported characters in path");
    expect(guard).not.toHaveBeenCalled();
  });

  it("forwards when the active guards let the request through", async () => {
    const pass: Guard = async (_c, next) => {
      await next();
    };
    const res = await makeApp(featureGuards(off, { uploads: pass, terminal: null })).request("/proxy/s/x", { method: "POST" });
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
