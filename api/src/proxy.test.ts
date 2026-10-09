import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { proxyRest, upstreamUrl, sessionAccess, proxyHttp, endOnDenial, type ProxyEnv } from "./proxy.js";
import type { AccessWatch } from "./authz.js";
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

describe("endOnDenial", () => {
  // A watch the test denies by hand.
  function fakeWatch() {
    let deny: (() => void) | undefined;
    const stop = vi.fn();
    const watch: AccessWatch = (onDenied) => {
      deny = () => onDenied({ allowed: false });
      return stop;
    };
    return { watch, stop, deny: () => deny!() };
  }

  // Chunks already queued may still arrive after a denial; then the stream ends.
  async function endsSoon(reader: ReadableStreamDefaultReader<Uint8Array>) {
    for (let i = 0; i < 5; i++) if ((await reader.read()).done) return true;
    return false;
  }

  // An event stream that never ends on its own.
  function endless() {
    const cancel = vi.fn();
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (ctl) => ctl.enqueue(new TextEncoder().encode(`data: ${n++}\n\n`)),
      cancel,
    });
    return { body, cancel };
  }

  it("passes events through until access is denied, then ends the stream", async () => {
    const { watch, stop, deny } = fakeWatch();
    const upstream = endless();
    const reader = endOnDenial(upstream.body, watch).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 0\n\n");
    deny();
    expect(await endsSoon(reader)).toBe(true);
    expect(upstream.cancel).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it("stops watching when the upstream ends", async () => {
    const { watch, stop } = fakeWatch();
    const reader = endOnDenial(new Response("data: x\n\n").body!, watch).getReader();
    while (!(await reader.read()).done);
    expect(stop).toHaveBeenCalled();
  });

  it("stops watching when the client goes away", async () => {
    const { watch, stop } = fakeWatch();
    const upstream = endless();
    await endOnDenial(upstream.body, watch).cancel();
    expect(stop).toHaveBeenCalled();
    expect(upstream.cancel).toHaveBeenCalled();
  });

  it("is applied to event streams proxied for a watched user", async () => {
    const { watch, deny } = fakeWatch();
    const upstream = endless();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(upstream.body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const app = new Hono<ProxyEnv>();
    app.use("*", async (c, next) => {
      c.set("userId", meta.userId);
      c.set("token", "tok");
      c.set("watchAccess", watch);
      await next();
    });
    app.all("/proxy/:sessionId/*", sessionAccess(store), proxyHttp());
    const reader = (await app.request("/proxy/alice-dev/global/event")).body!.getReader();
    await reader.read();
    deny();
    expect(await endsSoon(reader)).toBe(true);
  });
});
