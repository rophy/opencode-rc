import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { ProxyEnv } from "./proxy.js";
import { canonicalPath } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";
import { parseConfig } from "../../config/schema.js";
import { isTerminalPath, terminalGuard } from "./terminal-guard.js";

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
  app.all("/proxy/:sessionId/*", v1Guards(config), async (c, next) => {
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
    ["//pty//1", "/pty/1"],
    ["/a/b/../c", "/a/c"],
    ["/%70ty", "/pty"],
    ["/api/session/abc", "/api/session/abc"],
    ["/api/fs/read/a%20b.ts", "/api/fs/read/a%20b.ts"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalPath(input)).toBe(expected);
  });

  // The forwarded raw path is parsed again by fetch / WebSocket, where these change the path.
  it.each(["/x/%2f", "/x/%2F", "/x/%2e%2e", "/x/%25", "/x/%00", "/pty%2F1", "/pty%252F1", "/x/..%2Fpty"])("%s is null (encoded structural character)", (input) => {
    expect(canonicalPath(input)).toBeNull();
  });

  it.each(["/pty%3fx", "/pty%3bx", "/pty%23x", "/pty%5c1", "/pty;x/1", "/pty\\1", "/pty%09/1", "/pty\t/1", "/pty%00", "/pty%7f", "/pty%0a"])(
    "%s is null",
    (input) => {
      expect(canonicalPath(input)).toBeNull();
    },
  );

  it.each(["/a/.. ", "/a/ ..", "/a/b ", "/a/. /b", "/a/ . /b"])("%s is null (whitespace around dots or at the end)", (input) => {
    expect(canonicalPath(input)).toBeNull();
  });

  it("is null for a path that cannot be decoded", () => {
    expect(canonicalPath("/pty%E0%A4%A")).toBeNull();
  });
});

describe("terminalGuard with ?, ; and \\ in the path", () => {
  const app = new Hono<ProxyEnv>();
  app.all("/proxy/:sessionId/*", terminalGuard(), (c) => c.text("forwarded"));
  it.each(["/proxy/s/session%3b%5c..%5cpty%5cp%5cconnect", "/proxy/s/api/session%3f%5c..%5cpty%5cp%5cconnect"])("%s is refused", async (path) => {
    const res = await app.request(new Request(`http://localhost${path}`));
    expect(res.status).toBe(403);
  });
});

describe("terminalGuard with a literal space before dot segments", () => {
  const app = new Hono<ProxyEnv>();
  app.all("/proxy/:sessionId/*", terminalGuard(), (c) => c.text("forwarded"));
  it("refuses /pty/%20../.. (forwarded as /pty)", async () => {
    const res = await app.request(new Request("http://localhost/proxy/s/pty/%20../.."));
    expect(res.status).toBe(403);
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
  ])("rejects %s %s", async (method, path) => {
    const { app } = makeApp();
    const res = await app.request(`/proxy/alice-dev${path}`, { method });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("the terminal is disabled");
  });

  it("rejects a path with an encoded slash before the terminal guard", async () => {
    const { app } = makeApp();
    const res = await app.request("/proxy/alice-dev/pty%2Fabc/connect", { method: "GET" });
    expect(res.status).toBe(400);
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
