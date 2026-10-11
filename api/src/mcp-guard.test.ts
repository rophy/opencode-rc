import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";

// The 1.x mcp guard, as v1Guards runs it in front of the proxy.
function makeApp(enabled = false) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", v1Guards(parseConfig({ features: { mcp: { enabled } } })), (c) => c.text("forwarded"));
  return app;
}

const send = (app: Hono<ProxyEnv>, method: string, path: string, body?: unknown) =>
  app.request(`/proxy/alice-dev${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const changes: [string, string][] = [
  ["POST", "/mcp/docs/connect"],
  ["POST", "/mcp/docs/disconnect"],
  ["POST", "/mcp/docs/auth"],
  ["POST", "/mcp/docs/auth/callback"],
  ["POST", "/mcp/docs/auth/authenticate"],
  ["DELETE", "/mcp/docs/auth"],
  ["POST", "/MCP/docs/Connect"],
  ["POST", "/mcp/docs/connect/"],
  ["DELETE", "/Mcp/docs/Auth/"],
];

describe("mcp disabled (1.x)", () => {
  it.each(changes)("refuses %s %s", async (method, path) => {
    const res = await send(makeApp(), method, path, method === "POST" ? {} : undefined);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("MCP changes are disabled");
  });

  it.each([
    ["GET", "/mcp"],
    ["GET", "/experimental/resource"],
    ["GET", "/config"],
  ])("forwards %s %s", async (method, path) => {
    expect(await (await send(makeApp(), method, path)).text()).toBe("forwarded");
  });
});

describe("mcp enabled (1.x)", () => {
  it.each(changes)("forwards %s %s", async (method, path) => {
    expect(await (await send(makeApp(true), method, path, method === "POST" ? {} : undefined)).text()).toBe("forwarded");
  });
});
