import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { isV1Session, versionedGuards } from "./guards.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("isV1Session", () => {
  it("treats a missing or 1.x version as 1.x", () => {
    expect(isV1Session(undefined)).toBe(true);
    expect(isV1Session("")).toBe(true);
    expect(isV1Session("1.18.29")).toBe(true);
  });
  it("treats anything else as 2.x", () => {
    expect(isV1Session("2.0.26")).toBe(false);
    expect(isV1Session("3.0.0")).toBe(false);
    expect(isV1Session("garbage")).toBe(false);
  });
});

describe("versionedGuards", () => {
  function makeApp(config: unknown, opencodeVersion?: string) {
    const app = new Hono<ProxyEnv>();
    app.use("*", async (c, next) => {
      c.set("userId", "u");
      c.set("token", "t");
      c.set("session", { id: "s", userId: "u", directory: "/w", gatewayAddr: "gw:9090", createdAt: "", opencodeVersion } as never);
      await next();
    });
    app.all("/proxy/:sessionId/*", versionedGuards(parseConfig(config)), (c) => c.text("forwarded"));
    return app;
  }
  const call = (app: Hono<ProxyEnv>, method: string, path: string) => app.request(`/proxy/s${path}`, { method });

  it("refuses 2.x-only routes outside /api on a 1.x session", async () => {
    const app = makeApp({}, "1.18.29");
    expect((await call(app, "GET", "/auth/connect/abc")).status).toBe(403);
    expect((await call(app, "GET", "/session")).status).toBe(200);
  });

  it("uses the 1.x set when the session has no version", async () => {
    const app = makeApp({ features: { shell: { enabled: false } } });
    const res = await call(app, "POST", "/session/x/shell");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("shell commands are disabled");
    expect(await (await call(app, "GET", "/session")).text()).toBe("forwarded");
  });

  it("uses the 2.x set for a 2.x session", async () => {
    const app = makeApp({}, "2.0.26");
    const res = await call(app, "GET", "/session");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { _tag: string })._tag).toBe("FeatureDisabled");
    expect(await (await call(app, "GET", "/api/session")).text()).toBe("forwarded");
  });

  it("keeps the 1.x and 2.x toggles independent", async () => {
    const config = { features: { terminal: { enabled: false } }, opencodeV2: { features: { terminal: { enabled: true } } } };
    expect((await call(makeApp(config, "1.18.29"), "POST", "/pty")).status).toBe(403);
    expect(await (await call(makeApp(config, "2.0.26"), "POST", "/api/pty")).text()).toBe("forwarded");
  });
});
