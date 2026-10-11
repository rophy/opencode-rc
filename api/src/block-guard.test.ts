import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";

// The shell and share guards, as v1Guards runs them in front of the proxy.
function makeApp(features: Record<string, { enabled: boolean }>) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", v1Guards(parseConfig({ features })), (c) => c.text("forwarded"));
  return app;
}

const send = (app: Hono<ProxyEnv>, method: string, path: string, body: unknown = {}) =>
  app.request(`/proxy/alice-dev${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("shell guard", () => {
  const app = makeApp({ shell: { enabled: false } });

  it.each(["/session/ses_1/shell", "/session/ses_1/shell/", "/SESSION/ses_1/SHELL"])("rejects POST %s", async (path) => {
    const res = await send(app, "POST", path);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("shell commands are disabled");
  });

  it("rejects an encoded variant as an unplain path", async () => {
    expect((await send(app, "POST", "/session/ses_1%2Fshell")).status).toBe(400);
  });

  it.each([
    ["POST", "/session/ses_1/prompt_async"],
    ["POST", "/session/ses_1/command"],
    ["GET", "/session/ses_1/shell"],
  ])("lets %s %s through", async (method, path) => {
    expect(await (await send(app, method, path)).text()).toBe("forwarded");
  });

  it("does nothing when shell commands are enabled", async () => {
    expect(await (await send(makeApp({}), "POST", "/session/ses_1/shell")).text()).toBe("forwarded");
  });
});

describe("share guard", () => {
  const app = makeApp({ share: { enabled: false } });

  it("rejects publishing a session", async () => {
    const res = await send(app, "POST", "/session/ses_1/share");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("sharing is disabled");
  });

  it("still lets a session be unshared", async () => {
    expect(await (await send(app, "DELETE", "/session/ses_1/share")).text()).toBe("forwarded");
  });

  it.each(["/config", "/global/config", "/Global/Config/"])("refuses config fields that share sessions on PATCH %s", async (path) => {
    for (const body of [{ share: "auto" }, { autoshare: true }, { enterprise: { url: "https://share.example.test" } }]) {
      const res = await send(app, "PATCH", path, body);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("sharing is disabled");
    }
    expect(await (await send(app, "PATCH", path, { disabled_providers: ["anthropic"] })).text()).toBe("forwarded");
  });

  it("forwards the share config fields while sharing is enabled", async () => {
    expect(await (await send(makeApp({}), "PATCH", "/config", { share: "auto" })).text()).toBe("forwarded");
  });
});

describe("export", () => {
  it("has no API guard: disabling it guards nothing", async () => {
    const app = makeApp({ export: { enabled: false } });
    expect(await (await send(app, "GET", "/session/ses_1/message")).text()).toBe("forwarded");
  });
});
