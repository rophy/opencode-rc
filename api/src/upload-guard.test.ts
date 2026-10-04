import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import { sessionAccess, proxyHttp, type ProxyEnv } from "./proxy.js";
import { isUploadPart, uploadGuard } from "./upload-guard.js";
import type { SessionStore, SessionMeta } from "./store.js";

const meta: SessionMeta = {
  id: "alice-dev",
  userId: "alice@example.com",
  directory: "/project",
  gatewayAddr: "10.0.0.5:9090",
  createdAt: "2026-01-01T00:00:00Z",
};
const store = { get: async (id: string) => (id === meta.id ? meta : null) } as unknown as SessionStore;

function makeApp(enabled = false) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", meta.userId);
    c.set("token", "tok");
    await next();
  });
  app.all("/proxy/:sessionId/*", sessionAccess(store), uploadGuard(enabled), proxyHttp());
  return app;
}

let upstream: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const send = (method: string, path: string, body: string) =>
  makeApp().request(`/proxy/alice-dev${path}`, { method, headers: { "content-type": "application/json" }, body });

const dataPart = { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" };
const mention = { type: "file", mime: "text/plain", filename: "README.md", url: "file:///project/README.md" };
const mcp = {
  type: "file",
  mime: "text/plain",
  filename: "doc",
  url: "data:text/plain;base64,AAAA",
  source: { type: "resource", clientName: "docs", uri: "docs://a", text: { value: "", start: 0, end: 0 } },
};

describe("isUploadPart", () => {
  it.each([
    [dataPart, true],
    [{ ...dataPart, url: "https://example.com/a.png" }, true],
    [{ ...dataPart, url: undefined }, true],
    [mention, false],
    [{ ...mention, url: "FILE:///project/README.md" }, false],
    [mcp, false],
    [{ type: "text", text: "hi" }, false],
    ["file", false],
  ])("%j -> %s", (part, expected) => {
    expect(isUploadPart(part)).toBe(expected);
  });
});

describe("uploadGuard", () => {
  it.each(["message", "prompt_async", "command"])("rejects a data: part on POST /session/:id/%s", async (route) => {
    const res = await send("POST", `/session/ses_1/${route}`, JSON.stringify({ parts: [{ type: "text", text: "hi" }, dataPart] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("uploads are disabled");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects case and trailing-slash variants of the path", async () => {
    const res = await send("POST", "/Session/ses_1/Message/", JSON.stringify({ parts: [dataPart] }));
    expect(res.status).toBe(403);
  });

  it("rejects an http(s) file part", async () => {
    const res = await send("POST", "/session/ses_1/message", JSON.stringify({ parts: [{ ...dataPart, url: "https://x.example.com/a.png" }] }));
    expect(res.status).toBe(403);
  });

  it("rejects a PATCH that turns a part into an upload", async () => {
    const res = await send("PATCH", "/session/ses_1/message/msg_1/part/prt_1", JSON.stringify(dataPart));
    expect(res.status).toBe(403);
  });

  it("rejects a PATCH that turns a resource part into an upload", async () => {
    const res = await send("PATCH", "/session/ses_1/message/msg_1/part/prt_1", JSON.stringify(mcp));
    expect(res.status).toBe(403);
  });

  it("rejects POST /sync/replay outright", async () => {
    const res = await send("POST", "/sync/replay", "not even json");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("uploads are disabled");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a non-file: uri in a v2 prompt", async () => {
    const body = { prompt: { text: "hi", files: [{ uri: "file:///project/a.ts" }, { uri: "data:image/png;base64,AAAA" }] } };
    const res = await send("POST", "/api/session/ses_1/prompt", JSON.stringify(body));
    expect(res.status).toBe(403);
  });

  it("rejects a data: project icon", async () => {
    const res = await send("PATCH", "/project/prj_1", JSON.stringify({ icon: { override: "data:image/png;base64,AAAA" } }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for a matched request whose body is not JSON", async () => {
    const res = await send("POST", "/session/ses_1/message", "{not json");
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["a text prompt", "POST", "/session/ses_1/message", { parts: [{ type: "text", text: "hi" }] }],
    ["an @mention", "POST", "/session/ses_1/prompt_async", { parts: [mention] }],
    ["an MCP resource", "POST", "/session/ses_1/message", { parts: [mcp] }],
    ["a v2 prompt with workspace files", "POST", "/api/session/ses_1/prompt", { prompt: { text: "hi", files: [{ uri: "file:///project/a.ts" }] } }],
    ["a project name change", "PATCH", "/project/prj_1", { name: "x", icon: { color: "blue", override: "" } }],
  ])("forwards %s with the exact bytes", async (_name, method, path, body) => {
    const raw = ` ${JSON.stringify(body, null, 1)}\n`;
    const res = await send(method, path, raw);
    expect(res.status).toBe(204);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(raw);
  });

  it("streams unmatched requests untouched", async () => {
    const res = await send("POST", "/session", JSON.stringify({ title: "data:x" }));
    expect(res.status).toBe(204);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(ReadableStream);
  });

  it("does nothing when uploads are enabled", async () => {
    const res = await makeApp(true).request("/proxy/alice-dev/session/ses_1/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [dataPart] }),
    });
    expect(res.status).toBe(204);
  });
});
