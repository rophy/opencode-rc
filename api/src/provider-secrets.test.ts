import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import { versionedGuards } from "./guards.js";
import { providerSecretsStrip } from "./provider-secrets.js";
import { proxyHttp, type ProxyEnv } from "./proxy.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// A 1.x Provider.Info as GET /provider and GET /config/providers return it.
const legacyProvider = (id: string) => ({
  id,
  name: id,
  source: "env",
  env: ["TEST_KEY"],
  key: "test-key-value",
  options: {
    baseURL: "https://example.test/v1",
    apiKey: "test-key-value",
    APIKEY: "test-key-value",
    authToken: "test-token",
    token: "test-token",
    accessKeyId: "test-id",
    secretAccessKey: "test-secret",
    sessionToken: "test-session",
    googleAuthOptions: { credentials: { private_key: "test-private" } },
    region: "us-east-1",
    headers: {
      Authorization: "Bearer test-token",
      "X-Api-Key": "test-key-value",
      "api-key": "test-key-value",
      "x-goog-api-key": "test-key-value",
      "PRIVATE-TOKEN": "test-token",
      "X-Title": "opencode",
    },
  },
  models: {
    m1: {
      id: "m1",
      providerID: id,
      name: "Model 1",
      options: { apiKey: "test-key-value", reasoningEffort: "low" },
      headers: { authorization: "Bearer test-token", "User-Agent": "opencode" },
      variants: { high: { reasoningEffort: "high", apiKey: "test-key-value" } },
      limit: { context: 1000, output: 100 },
    },
  },
});

const cleanLegacy = (id: string) => ({
  id,
  name: id,
  source: "env",
  env: ["TEST_KEY"],
  models: { m1: { id: "m1", providerID: id, name: "Model 1", variants: { high: {} }, limit: { context: 1000, output: 100 } } },
});

// A 1.18 ProviderV2.Info / ModelV2.Info as the /api routes return them.
const apiItem = (id: string) => ({
  id,
  name: id,
  api: { type: "aisdk", package: "@ai-sdk/openai", settings: { apiKey: "test-key-value", organization: "org" } },
  request: { headers: { Authorization: "Bearer test-token", "X-Title": "opencode" }, body: { apiKey: "test-key-value", baseURL: "https://example.test" } },
  variants: [{ id: "high", headers: { "x-api-key": "test-key-value" }, body: { apiKey: "test-key-value", effort: "high" } }],
});

const cleanApiItem = (id: string) => ({ id, name: id, api: { type: "aisdk", package: "@ai-sdk/openai" }, variants: [{ id: "high" }] });

const location = { directory: "/w", project: { id: "p", directory: "/w" } };

describe("providerSecretsStrip", () => {
  const strip = (path: string, json: unknown) => providerSecretsStrip(path)!(json);

  it("removes keys and secret options from GET /provider, for all providers", () => {
    const json = { all: [legacyProvider("openai"), legacyProvider("anthropic")], default: { openai: "m1" }, connected: ["openai"] };
    expect(strip("/provider", json)).toEqual({
      all: [cleanLegacy("openai"), cleanLegacy("anthropic")],
      default: { openai: "m1" },
      connected: ["openai"],
    });
  });

  it("removes keys and secret options from GET /config/providers", () => {
    const json = { providers: [legacyProvider("openai")], default: { openai: "m1" } };
    expect(strip("/config/providers", json)).toEqual({ providers: [cleanLegacy("openai")], default: { openai: "m1" } });
  });

  it("removes provider options and headers from GET /config and GET /global/config", () => {
    const { key: _key, source: _source, ...entry } = legacyProvider("openai");
    const { source: _s, ...cleanEntry } = cleanLegacy("openai");
    for (const path of ["/config", "/global/config"]) {
      const json = { model: "openai/m1", provider: { openai: { ...entry, npm: "@ai-sdk/openai", headers: { Authorization: "x" } } }, mcp: {} };
      expect(strip(path, json)).toEqual({ model: "openai/m1", provider: { openai: { ...cleanEntry, npm: "@ai-sdk/openai" } }, mcp: {} });
    }
    expect(strip("/config", { model: "openai/m1" })).toEqual({ model: "openai/m1" });
  });

  it("removes MCP credentials from GET /config and GET /global/config", () => {
    const mcp = {
      local: { type: "local", command: ["srv"], environment: { TOKEN: "test-token" }, enabled: true },
      remote: { type: "remote", url: "https://mcp.example.test", headers: { Authorization: "Bearer test-token" }, oauth: { clientId: "id", clientSecret: "test-secret", scope: "read" } },
      plain: { type: "remote", url: "https://mcp.example.test", oauth: false },
    };
    const clean = {
      local: { type: "local", command: ["srv"], enabled: true },
      remote: { type: "remote", url: "https://mcp.example.test", oauth: { clientId: "id", scope: "read" } },
      plain: { type: "remote", url: "https://mcp.example.test", oauth: false },
    };
    for (const path of ["/config", "/global/config"]) {
      expect(strip(path, { mcp, provider: { openai: { options: { apiKey: "test-key-value" } } } })).toEqual({ mcp: clean, provider: { openai: {} } });
      expect(strip(path, { mcp: { odd: null, list: [1] } })).toEqual({ mcp: { odd: null, list: [1] } });
    }
  });

  it("leaves MCP entries alone on the provider routes", () => {
    const json = { all: [], mcp: { s: { environment: { A: "b" } } } };
    expect(strip("/provider", json)).toEqual(json);
  });

  it("cleans the 1.18 /api provider and model routes", () => {
    expect(strip("/api/provider", { location, data: [apiItem("openai")] })).toEqual({ location, data: [cleanApiItem("openai")] });
    expect(strip("/api/provider/openai", { location, data: apiItem("openai") })).toEqual({ location, data: cleanApiItem("openai") });
    expect(strip("/api/model", { location, data: [apiItem("m1")] })).toEqual({ location, data: [cleanApiItem("m1")] });
  });

  it("keeps the fields the UI reads", () => {
    const provider = { id: "p", name: "p", source: "custom", env: [], models: { m: { id: "m", name: "M", api: { id: "m", npm: "x", url: "" } } } };
    expect(strip("/provider", { all: [provider], default: { p: "m" }, connected: ["p"] })).toEqual({ all: [provider], default: { p: "m" }, connected: ["p"] });
  });

  it("tolerates other shapes", () => {
    expect(strip("/provider", null)).toBeNull();
    expect(strip("/provider", [1])).toEqual([1]);
    expect(strip("/provider", { all: "x" })).toEqual({ all: "x" });
    expect(strip("/api/provider", { data: [null, { id: "x", api: 1, variants: "v" }] })).toEqual({ data: [null, { id: "x", api: 1, variants: "v" }] });
  });

  it("matches the paths ignoring case and a trailing slash", () => {
    expect(providerSecretsStrip("/Provider/")).not.toBeNull();
    expect(providerSecretsStrip("//config//providers")).not.toBeNull();
    expect(providerSecretsStrip("/API/model")).not.toBeNull();
    expect(providerSecretsStrip("/Global/Config/")).not.toBeNull();
  });

  it("matches no other route", () => {
    for (const path of ["/provider/auth", "/config/x", "/global/config/x", "/api/integration", "/session", "/api/provider/a/b", "/%2fprovider"]) {
      expect(providerSecretsStrip(path)).toBeNull();
    }
  });
});

describe("provider responses through the proxy", () => {
  function makeApp(opencodeVersion?: string) {
    const app = new Hono<ProxyEnv>();
    app.use("*", async (c, next) => {
      c.set("userId", "u");
      c.set("token", "t");
      c.set("session", { id: "s", userId: "u", directory: "/w", gatewayAddr: "gw:9090", createdAt: "", opencodeVersion } as never);
      await next();
    });
    app.all("/proxy/:sessionId/*", versionedGuards(parseConfig({})), proxyHttp());
    return app;
  }
  const listing = () => JSON.stringify({ all: [legacyProvider("openai")], default: { openai: "m1" }, connected: ["openai"] });
  const upstream = (body: BodyInit | null, init: ResponseInit) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, init));
  const sentHeaders = (spy: ReturnType<typeof upstream>) => new Headers((spy.mock.calls[0] as [string, RequestInit])[1].headers);

  it("removes secrets on a 1.x session, keeps status and headers, and asks for identity encoding", async () => {
    const spy = upstream(listing(), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "9999", "content-encoding": "gzip", "x-opencode": "1" },
    });
    const res = await makeApp("1.18.29").request("/proxy/s/provider", { headers: { "accept-encoding": "gzip, br" } });
    expect(sentHeaders(spy).get("accept-encoding")).toBe("identity");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-opencode")).toBe("1");
    expect(res.headers.get("content-encoding")).toBeNull();
    const text = await res.text();
    expect(res.headers.get("content-length")).not.toBe("9999");
    expect(text).not.toContain("test-key-value");
    expect(JSON.parse(text)).toEqual({ all: [cleanLegacy("openai")], default: { openai: "m1" }, connected: ["openai"] });
  });

  it("removes secrets for sessions with no version (1.x)", async () => {
    upstream(listing(), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    expect(await (await makeApp().request("/proxy/s/Provider/")).text()).not.toContain("test-key-value");
  });

  it("passes error responses through", async () => {
    upstream('{"key":"test-key-value"}', { status: 500, headers: { "content-type": "application/json" } });
    const res = await makeApp("1.18.29").request("/proxy/s/provider");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"key":"test-key-value"}');
  });

  it("rewrites a 2xx body whatever its content type", async () => {
    upstream(listing(), { status: 200, headers: { "content-type": "text/plain" } });
    const res = await makeApp("1.18.29").request("/proxy/s/provider");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).not.toContain("test-key-value");
  });

  it("refuses a 2xx body it cannot parse", async () => {
    for (const [body, type] of [["{not json", "application/json"], ["plain", "text/plain"], ["", "application/json"]]) {
      vi.restoreAllMocks();
      upstream(body, { status: 200, headers: { "content-type": type } });
      const res = await makeApp("1.18.29").request("/proxy/s/config/providers");
      expect(res.status).toBe(502);
      expect(await res.text()).toBe("unexpected response from opencode");
    }
  });

  it("removes provider options from GET /config", async () => {
    upstream(JSON.stringify({ provider: { openai: { options: { apiKey: "test-key-value" } } } }), { status: 200, headers: { "content-type": "application/json" } });
    expect(await (await makeApp("1.18.29").request("/proxy/s/config")).json()).toEqual({ provider: { openai: {} } });
  });

  it("streams other routes untouched", async () => {
    const body = new ReadableStream({ start: (ctl) => (ctl.enqueue(new TextEncoder().encode(listing())), ctl.close()) });
    const spy = upstream(body, { status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" } });
    const res = await makeApp("1.18.29").request("/proxy/s/session", { headers: { "accept-encoding": "gzip" } });
    expect(sentHeaders(spy).get("accept-encoding")).toBe("gzip");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.body).toBe(body);
  });

  it("leaves HEAD requests to the provider routes alone", async () => {
    const spy = upstream(null, { status: 200, headers: { "content-type": "application/json", "content-length": "42" } });
    const res = await makeApp("1.18.29").request("/proxy/s/provider", { method: "HEAD", headers: { "accept-encoding": "gzip" } });
    expect(sentHeaders(spy).get("accept-encoding")).toBe("gzip");
    expect(res.headers.get("content-length")).toBe("42");
  });

  it("leaves 2.x sessions untouched", async () => {
    const json = JSON.stringify({ location, data: [apiItem("openai")] });
    upstream(json, { status: 200, headers: { "content-type": "application/json" } });
    expect(await (await makeApp("2.0.26").request("/proxy/s/api/provider")).text()).toBe(json);
  });
});
