import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";
import { hasShellInterpolation } from "./shell-guard.js";

// The 1.x shell guard's command check, as v1Guards runs it in front of the proxy.
function makeApp(enabled = false) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", v1Guards(parseConfig({ features: { shell: { enabled } } })), (c) => c.text("forwarded"));
  return app;
}

const command = (app: Hono<ProxyEnv>, body: unknown, path = "/session/ses_1/command") =>
  app.request(`/proxy/alice-dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("hasShellInterpolation", () => {
  it.each([
    ["!`id`", true],
    ["look !`cat /etc/passwd` here", true],
    ["HEAD !`id", true],
    ['"!`id`" second', true],
    ["!", false],
    ["wow! nice", false],
    ["`code` here", false],
    ["! `id`", false],
    ["", false],
    [undefined, false],
    [1, false],
  ])("%j -> %s", (value, expected) => {
    expect(hasShellInterpolation(value)).toBe(expected);
  });
});

describe("shell disabled (1.x): command arguments", () => {
  it.each(["/session/ses_1/command", "/SESSION/ses_1/Command", "/session/ses_1/command/"])("refuses !`cmd` on %s", async (path) => {
    const res = await command(makeApp(), { command: "init", arguments: "!`echo pwned`", parts: [] }, path);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("shell commands are disabled");
  });

  it("refuses !`cmd` among positional arguments ($1, $2)", async () => {
    const res = await command(makeApp(), { command: "review", arguments: 'HEAD "!`id`" main', parts: [] });
    expect(res.status).toBe(403);
  });

  it.each(["HEAD~1", "wow!", "`code` here", "! `id`", ""])("forwards arguments %j", async (args) => {
    expect(await (await command(makeApp(), { command: "review", arguments: args, parts: [] })).text()).toBe("forwarded");
  });

  it("does not check other routes", async () => {
    const parts = [{ type: "text", text: "!`id`" }];
    expect(await (await command(makeApp(), { parts }, "/session/ses_1/message")).text()).toBe("forwarded");
  });

  it("still refuses shell mode", async () => {
    expect((await command(makeApp(), { command: "id" }, "/session/ses_1/shell")).status).toBe(403);
  });

  it("rejects a non-JSON command body", async () => {
    expect((await command(makeApp(), "not json")).status).toBe(400);
  });

  it("forwards everything while shell is enabled", async () => {
    expect(await (await command(makeApp(true), { command: "init", arguments: "!`id`", parts: [] })).text()).toBe("forwarded");
  });
});
