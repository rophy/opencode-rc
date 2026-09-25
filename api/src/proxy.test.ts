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

  // Bun closes connections idle for 10s by default; opencode's SSE heartbeat is also 10s.
  it("disables the server idle timeout for event streams", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const server = { timeout: vi.fn() };
    const res = await makeApp("alice@example.com").request("/proxy/alice-dev/global/event", {}, server);
    expect(res.status).toBe(200);
    expect(server.timeout).toHaveBeenCalledTimes(1);
    const [req, seconds] = server.timeout.mock.calls[0];
    expect(req).toBeInstanceOf(Request);
    expect(seconds).toBe(0);
  });

  it("keeps the server idle timeout for ordinary responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }),
    );
    const server = { timeout: vi.fn() };
    await makeApp("alice@example.com").request("/proxy/alice-dev/api/health", {}, server);
    expect(server.timeout).not.toHaveBeenCalled();
  });
});
