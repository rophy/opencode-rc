import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { ProxyEnv } from "./proxy.js";
import { MAX_BODY_BYTES, bodyError, jsonBody } from "./request-body.js";

function makeApp() {
  const app = new Hono<ProxyEnv>();
  app.post("/", async (c) => {
    const body = await jsonBody(c);
    if (typeof body === "string") return bodyError(c, body);
    return c.json({ json: body.json ?? null, bytes: c.get("body")!.byteLength });
  });
  return app;
}

describe("jsonBody", () => {
  it("parses and keeps the bytes", async () => {
    const res = await makeApp().request("/", { method: "POST", body: '{"a":1}' });
    expect(await res.json()).toEqual({ json: { a: 1 }, bytes: 7 });
  });

  it("treats an empty body as no fields", async () => {
    expect(await (await makeApp().request("/", { method: "POST" })).json()).toEqual({ json: null, bytes: 0 });
  });

  it("rejects a body that is not JSON", async () => {
    const res = await makeApp().request("/", { method: "POST", body: "nope" });
    expect(res.status).toBe(400);
  });

  it("refuses a declared length over the cap without reading", async () => {
    const res = await makeApp().request(
      new Request("http://localhost/", { method: "POST", body: "{}", headers: { "content-length": String(MAX_BODY_BYTES + 1) } }),
    );
    expect(res.status).toBe(413);
  });

  it("refuses a streamed body over the cap", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = await makeApp().request(new Request("http://localhost/", { method: "POST", body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
  });
});
