import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  MIN_CLIENT_PROTOCOL, PROTOCOL, PROTOCOL_HEADER, protocolHeader, readProtocol, requireClientProtocol,
} from "./protocol.js";

function app() {
  const a = new Hono();
  a.use("*", protocolHeader());
  a.use("/checked/*", requireClientProtocol());
  a.get("/checked/x", (c) => c.json({ ok: true }));
  a.get("/open", (c) => c.json({ ok: true }));
  return a;
}

describe("readProtocol", () => {
  it("parses non-negative integers and treats anything else as 0", () => {
    expect(readProtocol("3")).toBe(3);
    for (const v of [undefined, null, "", "abc", "-1", "1.5", "2x"]) expect(readProtocol(v)).toBe(0);
  });
});

describe("protocol middleware", () => {
  it("starts at protocol 1", () => {
    expect(PROTOCOL).toBe(1);
    expect(MIN_CLIENT_PROTOCOL).toBe(1);
    expect(PROTOCOL_HEADER).toBe("OpenCode-RC-Protocol");
  });

  it("rejects a client without the header on checked paths", async () => {
    const res = await app().request("/checked/x");
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "client_outdated", client: 0, minimum: 1, server: 1 });
    expect(res.headers.get(PROTOCOL_HEADER)).toBe("1");
  });

  it("accepts a current client", async () => {
    const res = await app().request("/checked/x", { headers: { [PROTOCOL_HEADER]: "1" } });
    expect(res.status).toBe(200);
  });

  it("leaves unchecked paths alone and still sends the header", async () => {
    const res = await app().request("/open");
    expect(res.status).toBe(200);
    expect(res.headers.get(PROTOCOL_HEADER)).toBe("1");
  });
});
