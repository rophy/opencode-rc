import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";
import { downloadGuard } from "./download-guard.js";
import { parseConfig } from "../../config/schema.js";

const off = parseConfig({ features: { downloads: { enabled: false } } });

// guard alone (so paths other guards reject still reach it) or the full v1 guard set
function makeApp(config: ReturnType<typeof parseConfig> | "alone" = off) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", config === "alone" ? downloadGuard() : v1Guards(config), (c) => c.text("forwarded"));
  return app;
}

const get = (app: Hono<ProxyEnv>, path: string, method = "GET") =>
  app.request(new Request(`http://localhost/proxy/s${path}`, { method }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("downloads disabled (1.x)", () => {
  it.each([
    "/file/content?path=a.ts",
    "/FILE/content?path=a.ts",
    "//file//content",
    "/%66ile/content?path=a.ts",
    "/api/fs/read/src/a.ts",
    "/api/fs/read/a%20b.ts",
  ])("blocks GET %s", async (path) => {
    const res = await get(makeApp(), path);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("file downloads are disabled");
  });

  it.each(["/api/fs/read/", "/x/%2f", "/api/fs/read/src/%2e%2e%2fa"])("blocks GET %s (guard alone)", async (path) => {
    expect((await get(makeApp("alone"), path)).status).toBe(403);
  });

  it("blocks HEAD", async () => {
    expect((await get(makeApp(), "/file/content?path=a", "HEAD")).status).toBe(403);
    expect((await get(makeApp(), "/api/fs/read/a", "HEAD")).status).toBe(403);
  });

  it.each(["/file?path=src", "/find/file?query=a", "/api/fs/list", "/api/fs/find?query=a", "/session"])(
    "lets GET %s through",
    async (path) => {
      expect(await (await get(makeApp(), path)).text()).toBe("forwarded");
    },
  );

  it("leaves a non-GET to /file/content to the other guards", async () => {
    expect(await (await get(makeApp(), "/file/content", "POST")).text()).toBe("forwarded");
  });

  it("allows everything while enabled", async () => {
    const on = makeApp(parseConfig({}));
    expect(await (await get(on, "/file/content?path=a")).text()).toBe("forwarded");
    expect(await (await get(on, "/api/fs/read/a")).text()).toBe("forwarded");
  });
});
