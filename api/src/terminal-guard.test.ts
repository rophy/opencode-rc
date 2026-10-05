import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { ProxyEnv } from "./proxy.js";
import { canonicalPath } from "./proxy.js";
import { featureGuards } from "./feature-guards.js";
import { parseConfig } from "../../config/schema.js";
import { isTerminalPath } from "./terminal-guard.js";

const terminalOff = parseConfig({ features: { terminal: { enabled: false } } });
const terminalOn = parseConfig({});

// The guards in front of a stand-in for the WebSocket relay and the proxy, as in index.ts.
function makeApp(config = terminalOff) {
  const relay = vi.fn();
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", featureGuards(config), async (c, next) => {
    if ((c.req.header("upgrade") ?? "").toLowerCase() === "websocket") {
      relay();
      return c.text("relayed");
    }
    await next();
  }, (c) => c.text("forwarded"));
  return { app, relay };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("canonicalPath", () => {
  it.each([
    ["/pty/1/connect", "/pty/1/connect"],
    ["/PTY", "/pty"],
    ["/pty%2F1", "/pty/1"],
    ["/pty%252F1", "/pty/1"],
    ["/pty%5C1", "/pty/1"],
    ["//pty//1", "/pty/1"],
    ["/x/..%2Fpty", "/pty"],
    ["/%70ty", "/pty"],
    ["/pty%09/1", "/pty/1"],
    ["/pty;x/1", "/pty"],
    ["/pty%3Fx", "/pty"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalPath(input)).toBe(expected);
  });

  it("is null for a path that cannot be decoded", () => {
    expect(canonicalPath("/pty%E0%A4%A")).toBeNull();
  });
});

describe("isTerminalPath", () => {
  it.each(["/pty", "/pty/", "/pty/shells", "/pty/abc/connect", "/api/pty/abc/connect-token", "/PTY/x", "/pty%2Fx", "/%E0%A4%A"])(
    "%s is a terminal path",
    (path) => {
      expect(isTerminalPath(path)).toBe(true);
    },
  );

  it.each(["/session", "/ptyx", "/api/session/s/prompt", "/file/content", "/x/pty"])("%s is not", (path) => {
    expect(isTerminalPath(path)).toBe(false);
  });
});

describe("terminal guard", () => {
  it.each([
    ["GET", "/pty/shells"],
    ["POST", "/pty"],
    ["PUT", "/pty/abc"],
    ["DELETE", "/pty/abc"],
    ["POST", "/pty/abc/connect-token"],
    ["POST", "/api/pty/abc/connect-token"],
    ["GET", "/pty%2Fabc/connect"],
  ])("rejects %s %s", async (method, path) => {
    const { app } = makeApp();
    const res = await app.request(`/proxy/alice-dev${path}`, { method });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("the terminal is disabled");
  });

  it("refuses the WebSocket upgrade before the relay", async () => {
    const { app, relay } = makeApp();
    const res = await app.request("/proxy/alice-dev/pty/abc/connect", { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(403);
    expect(relay).not.toHaveBeenCalled();
  });

  it("lets other requests through", async () => {
    const { app } = makeApp();
    const res = await app.request("/proxy/alice-dev/session/ses_1/message", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("forwarded");
  });

  it("does nothing when the terminal is enabled", async () => {
    const { app, relay } = makeApp(terminalOn);
    const res = await app.request("/proxy/alice-dev/pty/abc/connect", { headers: { upgrade: "websocket" } });
    expect(await res.text()).toBe("relayed");
    expect(relay).toHaveBeenCalled();
  });
});
