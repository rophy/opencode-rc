import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { closeReason, relayCloseCode } from "./ws-close.js";

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

describe("closeReason", () => {
  it("keeps reasons that fit a close frame", () => {
    expect(closeReason("left the office")).toBe("left the office");
  });

  it("cuts long reasons to 123 bytes without splitting a character", () => {
    const cut = closeReason("é".repeat(100));
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(123);
    expect(cut).toBe("é".repeat(61));
  });
});

describe("relayEvents", async () => {
  vi.stubGlobal("Bun", { write: async () => 0 });
  const { relayEvents } = await import("./ws-relay.js");
  vi.unstubAllGlobals();

  // Stands in for the WebSocket to the gateway.
  class FakeUpstream {
    static OPEN = 1;
    static last: FakeUpstream;
    readyState = 0;
    binaryType = "";
    closed: [number, string] | undefined;
    onopen?: () => void;
    onmessage?: (e: { data: unknown }) => void;
    onclose?: (e: { code: number; reason: string }) => void;
    onerror?: () => void;
    constructor(public url: string) {
      FakeUpstream.last = this;
    }
    send() {}
    close(code: number, reason: string) {
      this.closed = [code, reason];
    }
  }

  function open(watch?: (onDenied: (d: { allowed: false; reason?: string }) => void) => () => void) {
    vi.stubGlobal("WebSocket", FakeUpstream);
    const vars: Record<string, unknown> = {
      session: { id: "s1", gatewayAddr: "gw:9090" },
      token: "tok",
      watchAccess: watch,
    };
    const c = { get: (k: string) => vars[k], req: { path: "/proxy/s1/pty/1/connect", url: "http://x/proxy/s1/pty/1/connect" } };
    const events = relayEvents(c as never);
    const client = { close: vi.fn(), send: vi.fn() };
    events.onOpen!(new Event("open"), client as never);
    return { events, client, upstream: FakeUpstream.last };
  }

  it("closes both sides with 1008 and the reason when access is denied", () => {
    let deny: (reason?: string) => void = () => {};
    const stop = vi.fn();
    const { client, upstream } = open((onDenied) => {
      deny = (reason) => onDenied({ allowed: false, ...(reason ? { reason } : {}) });
      return stop;
    });
    deny("left the office");
    expect(client.close).toHaveBeenCalledWith(1008, "left the office");
    expect(upstream.closed).toEqual([1000, "access revoked"]);
    vi.unstubAllGlobals();
  });

  it("says access revoked when the webhook gave no reason", () => {
    let deny = () => {};
    const { client } = open((onDenied) => {
      deny = () => onDenied({ allowed: false });
      return () => {};
    });
    deny();
    expect(client.close).toHaveBeenCalledWith(1008, "access revoked");
    vi.unstubAllGlobals();
  });

  it("stops watching when either side closes", () => {
    const stop = vi.fn();
    const a = open(() => stop);
    a.events.onClose!({ code: 1000 } as CloseEvent);
    expect(stop).toHaveBeenCalledTimes(1);
    const b = open(() => stop);
    b.upstream.onclose!({ code: 1000, reason: "" });
    expect(stop).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("relays without a watch", () => {
    const { client, upstream } = open();
    upstream.onclose!({ code: 1000, reason: "bye" });
    expect(client.close).toHaveBeenCalledWith(1000, "bye");
    vi.unstubAllGlobals();
  });
});

describe("wsRelay", async () => {
  // hono/bun reads the Bun global at import time; tests run under Node.
  vi.stubGlobal("Bun", { write: async () => 0 });
  const { wsRelay } = await import("./ws-relay.js");
  vi.unstubAllGlobals();

  const upgrade = vi.fn(() => true);
  const app = new Hono();
  app.all(
    "/proxy/s1/*",
    async (c, next) => {
      c.set("session" as never, { id: "s1", gatewayAddr: "gw:9090" } as never);
      c.set("token" as never, "tok" as never);
      await next();
    },
    wsRelay() as never,
    (c) => c.text("http"),
  );
  const send = (method: string, headers: Record<string, string> = {}) =>
    app.request("/proxy/s1/pty/1/connect", { method, headers }, { server: { upgrade } });

  it("upgrades GET WebSocket requests without reaching the HTTP proxy", async () => {
    upgrade.mockClear();
    const res = await send("GET", { upgrade: "websocket" });
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(await res.text()).not.toBe("http");
  });

  it("passes plain requests and non-GET upgrades to the HTTP proxy", async () => {
    upgrade.mockClear();
    expect(await (await send("GET")).text()).toBe("http");
    expect(await (await send("POST", { upgrade: "websocket" })).text()).toBe("http");
    expect(upgrade).not.toHaveBeenCalled();
  });
});
