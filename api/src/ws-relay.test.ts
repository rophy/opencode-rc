import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { relayCloseCode } from "./ws-close.js";

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
