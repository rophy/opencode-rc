import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import { sessionAccess, proxyHttp, type ProxyEnv } from "./proxy.js";
import { isUploadPart } from "./upload-guard.js";
import { featureGuards, isPlainPath, rawPath } from "./feature-guards.js";
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
  app.all("/proxy/:sessionId/*", sessionAccess(store), featureGuards({ features: { uploads: { enabled }, terminal: { enabled: true } } }), proxyHttp());
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

describe("isPlainPath", () => {
  it.each([
    ["/proxy/alice-dev/session/ses_1/message", true],
    ["/proxy/my-host.local/api/session/ses_1/prompt", true],
    ["/proxy/a/b_c~d", true],
    ["/proxy/a/./message", false],
    ["/proxy/a/../message", false],
    ["/proxy/a/.", false],
    ["/proxy/a/..", false],
    ["/proxy/a/%2e%2e/b", false],
    ["/proxy/a\\b", false],
    ["/proxy/a;b", false],
    ["/proxy/a b", false],
    ["/proxy/a\tb", false],
  ])("%j -> %s", (path, expected) => {
    expect(isPlainPath(path)).toBe(expected);
  });
});

describe("rawPath", () => {
  it("returns the undecoded path of an absolute url, without the query", () => {
    expect(rawPath("http://x/a%2Fb;c?q=%2F")).toBe("/a%2Fb;c");
  });

  it.each(["/proxy/alice-dev/session", "", "http://[bad/x"])("returns null for an unparsable url %j", (url) => {
    expect(rawPath(url)).toBeNull();
  });
});

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

  it.each([
    ["a data: file part", JSON.stringify(dataPart)],
    ["a resource part", JSON.stringify(mcp)],
    ["a plain text part", JSON.stringify({ type: "text", text: "hi" })],
    [
      "a tool part with data: attachments",
      JSON.stringify({ type: "tool", state: { status: "completed", attachments: [dataPart] } }),
    ],
    ["a non-JSON body", "{not json"],
  ])("rejects PATCH of a part outright: %s", async (_name, body) => {
    const res = await send("PATCH", "/session/ses_1/message/msg_1/part/prt_1", body);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("uploads are disabled");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects case and trailing-slash variants of the PATCH part path", async () => {
    const res = await send("PATCH", "/Session/ses_1/Message/msg_1/Part/prt_1/", JSON.stringify({ type: "text", text: "hi" }));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["';'", "/session/ses_1/message;x"],
    ["%2F", "/session/ses_1%2Fmessage"],
    ["%3F", "/session/ses_1/message%3F"],
    ["%23", "/session/ses_1/message%23"],
    ["%3B", "/session/ses_1/message%3Bx"],
    ["%25", "/session/ses_1/message%252F"],
    ["%5C", "/session/ses_1%5Cmessage"],
    ["%5c", "/session/ses_1%5cmessage"],
    ["%09", "/session/ses_1/mes%09sage"],
    ["a trailing %20", "/session/ses_1/message%20"],
    ["%00", "/session/ses_1/message%00"],
    ["%01", "/session/ses_1/message%01"],
    ["x%5C..%5Cmessage", "/session/ses_1/x%5C..%5Cmessage"],
  ])("rejects a POST whose raw path contains %s", async (_name, path) => {
    const res = await send("POST", path, JSON.stringify({ parts: [dataPart] }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unsupported characters in path");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a PATCH of a part whose path hides a slash as %5C", async () => {
    const res = await send("PATCH", "/session/ses_1/message/msg_1/part%5Cprt_1", JSON.stringify({ type: "text", text: "hi" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unsupported characters in path");
    expect(upstream).not.toHaveBeenCalled();
  });

  // The URL parser resolves dot segments (also %2e forms) before the guard reads the raw
  // path, so a request carries the resolved path everywhere and the rules apply to it.
  it.each(["/session/ses_1/x/../message", "/session/./ses_1/message", "/session/ses_1/x/%2e%2e/message"])(
    "applies the rules to the resolved path of %s",
    async (path) => {
      const res = await send("POST", path, JSON.stringify({ parts: [dataPart] }));
      expect(res.status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("lets a GET with an encoded slash through", async () => {
    const res = await makeApp().request("/proxy/alice-dev/file/content%2Fa.ts", { method: "GET" });
    expect(res.status).toBe(204);
    expect(upstream).toHaveBeenCalled();
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
