import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";

// The 1.x config guard, as v1Guards runs it in front of the proxy.
function makeApp(enabled = false) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", v1Guards(parseConfig({ features: { config: { enabled } } })), (c) => c.text("forwarded"));
  return app;
}

const send = (app: Hono<ProxyEnv>, method: string, path: string, body?: unknown) =>
  app.request(`/proxy/alice-dev${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.text()).toBe("config changes are disabled");
}

async function expectForwarded(res: Response) {
  expect(await res.text()).toBe("forwarded");
}

const mcp = { name: "docs", config: { type: "remote", url: "https://example.com/mcp" } };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("config disabled (1.x)", () => {
  it.each(["/config", "/global/config", "/CONFIG", "/Global/Config", "/config/", "/global/config/"])("refuses PATCH %s", async (path) => {
    await expectRefused(await send(makeApp(), "PATCH", path, { disabled_providers: [] }));
  });

  it("refuses a config update whatever the body", async () => {
    await expectRefused(await send(makeApp(), "PATCH", "/global/config", {}));
    await expectRefused(await send(makeApp(), "PATCH", "/config", "not json"));
  });

  it.each(["/mcp", "/MCP", "/mcp/"])("refuses adding an MCP server on %s", async (path) => {
    await expectRefused(await send(makeApp(), "POST", path, mcp));
  });

  it.each([
    { commands: { start: "" } },
    { name: "p", commands: { start: "npm install" } },
    { name: "p", commands: {} },
    { commands: null },
  ])("refuses a project edit %j", async (body) => {
    await expectRefused(await send(makeApp(), "PATCH", "/project/prj_1", body));
  });

  it.each(["/PROJECT/prj_1", "/project/prj_1/"])("refuses project commands on %s", async (path) => {
    await expectRefused(await send(makeApp(), "PATCH", path, { commands: { start: "" } }));
  });

  it.each([{ name: "p" }, { name: "p", icon: { color: "pink", override: "" } }, {}])("forwards a project edit %j", async (body) => {
    await expectForwarded(await send(makeApp(), "PATCH", "/project/prj_1", body));
  });

  it("refuses a wellknown credential (it loads a remote config)", async () => {
    await expectRefused(await send(makeApp(), "PUT", "/auth/example", { type: "wellknown", key: "TOKEN", token: "t" }));
  });

  it("forwards API key sign-in and its removal", async () => {
    await expectForwarded(await send(makeApp(), "PUT", "/auth/anthropic", { type: "api", key: "sk-test" }));
    await expectForwarded(await send(makeApp(), "DELETE", "/auth/anthropic"));
  });

  it.each([
    ["GET", "/config"],
    ["GET", "/global/config"],
    ["GET", "/mcp"],
    ["GET", "/config/providers"],
    ["POST", "/mcp/docs/connect"],
    ["POST", "/mcp/docs/disconnect"],
    ["POST", "/session/ses_1/message"],
  ])("forwards %s %s", async (method, path) => {
    await expectForwarded(await send(makeApp(), method, path, method === "GET" ? undefined : {}));
  });

  it("rejects a non-JSON project edit", async () => {
    expect((await send(makeApp(), "PATCH", "/project/prj_1", "not json")).status).toBe(400);
  });
});

describe("config enabled (1.x)", () => {
  it.each([
    ["PATCH", "/config", { disabled_providers: [] }],
    ["PATCH", "/global/config", { disabled_providers: [] }],
    ["POST", "/mcp", mcp],
    ["PATCH", "/project/prj_1", { name: "p", commands: { start: "" } }],
    ["PUT", "/auth/example", { type: "wellknown", key: "TOKEN", token: "t" }],
  ])("forwards %s %s", async (method, path, body) => {
    await expectForwarded(await send(makeApp(true), method, path, body));
  });
});
