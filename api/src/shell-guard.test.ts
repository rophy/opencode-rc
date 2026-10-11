import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";
import { mayRunShell } from "./shell-guard.js";

// The 1.x shell guard, as v1Guards runs it in front of the proxy.
function makeApp(enabled = false) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", v1Guards(parseConfig({ features: { shell: { enabled } } })), (c) => c.text("forwarded"));
  return app;
}

const send = (app: Hono<ProxyEnv>, method: string, path: string, body?: unknown) =>
  app.request(`/proxy/alice-dev${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const command = (app: Hono<ProxyEnv>, body: unknown, path = "/session/ses_1/command") => send(app, "POST", path, body);

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.text()).toBe("shell commands are disabled");
}

async function expectForwarded(res: Response) {
  expect(await res.text()).toBe("forwarded");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("mayRunShell", () => {
  it.each([
    ["!`echo marker`", true],
    ["look !`echo marker` here", true],
    // The template can supply the closing backtick.
    ["HEAD !`id", true],
    ['"!`id`" second', true],
    // Followed by a backtick in the template (review.txt: $ARGUMENTS`).
    ["main!", true],
    ["!", true],
    // Quote trimming joins $1 and $2 into !`…` in a "$1$2" template.
    ['"a!" "`id`"', true],
    ["! `id`", true],
    ["wow! nice", true],
    ["!nice", false],
    ["a!b", false],
    ["`code` here", false],
    ["HEAD~1", false],
    ["", false],
    [undefined, false],
    [1, false],
  ])("%j -> %s", (value, expected) => {
    expect(mayRunShell(value)).toBe(expected);
  });
});

describe("shell disabled (1.x): command arguments", () => {
  it.each(["/session/ses_1/command", "/SESSION/ses_1/Command", "/session/ses_1/command/"])("refuses !`cmd` on %s", async (path) => {
    await expectRefused(await command(makeApp(), { command: "init", arguments: "!`echo marker`", parts: [] }, path));
  });

  it("refuses !`cmd` among positional arguments ($1, $2)", async () => {
    await expectRefused(await command(makeApp(), { command: "review", arguments: 'HEAD "!`id`" main', parts: [] }));
  });

  it("refuses arguments ending in !", async () => {
    await expectRefused(await command(makeApp(), { command: "review", arguments: "main!", parts: [] }));
  });

  it.each(["HEAD~1", "!nice", "`code` here", ""])("forwards arguments %j", async (args) => {
    await expectForwarded(await command(makeApp(), { command: "review", arguments: args, parts: [] }));
  });

  it("does not check prompt text (it is not interpolated)", async () => {
    const parts = [{ type: "text", text: "!`id`" }];
    await expectForwarded(await command(makeApp(), { parts }, "/session/ses_1/message"));
  });

  it("still refuses shell mode", async () => {
    expect((await command(makeApp(), { command: "id" }, "/session/ses_1/shell")).status).toBe(403);
  });

  it("rejects a non-JSON command body", async () => {
    expect((await command(makeApp(), "not json")).status).toBe(400);
  });
});

describe("shell disabled (1.x): worktrees and projects", () => {
  it("refuses a worktree with a start command", async () => {
    await expectRefused(await send(makeApp(), "POST", "/experimental/worktree", { name: "w", startCommand: "echo marker" }));
  });

  it.each([{}, { name: "w" }, { name: "w", startCommand: "" }, { name: "w", startCommand: "  " }])("forwards a worktree %j", async (body) => {
    await expectForwarded(await send(makeApp(), "POST", "/experimental/worktree", body));
  });

  it("forwards a worktree create with an empty body", async () => {
    await expectForwarded(await send(makeApp(), "POST", "/experimental/worktree"));
  });

  it("refuses a project start command", async () => {
    await expectRefused(await send(makeApp(), "PATCH", "/project/prj_1", { name: "p", commands: { start: "echo marker" } }));
  });

  it.each([{ name: "p" }, { name: "p", commands: { start: "" } }, { name: "p", commands: {} }])("forwards a project edit %j", async (body) => {
    await expectForwarded(await send(makeApp(), "PATCH", "/project/prj_1", body));
  });
});

describe("shell disabled (1.x): config and MCP", () => {
  it.each(["/config", "/global/config", "/Global/Config/"])("refuses config fields that run commands on %s", async (path) => {
    for (const key of ["command", "mcp", "shell", "plugin", "formatter", "lsp"]) {
      await expectRefused(await send(makeApp(), "PATCH", path, { [key]: {} }));
    }
  });

  it.each(["permission", "agent", "mode"])("refuses config %s (permission rules)", async (key) => {
    await expectRefused(await send(makeApp(), "PATCH", "/global/config", { [key]: {} }));
  });

  it("forwards the provider settings the UI sends", async () => {
    const body = {
      disabled_providers: ["anthropic"],
      provider: { custom: { npm: "@ai-sdk/openai-compatible", name: "Custom", options: { baseURL: "http://localhost:1/v1" } } },
    };
    await expectForwarded(await send(makeApp(), "PATCH", "/global/config", body));
  });

  it.each([
    ["POST", "/session"],
    ["PATCH", "/session/ses_1"],
  ])("refuses session permission rules on %s %s", async (method, path) => {
    await expectRefused(await send(makeApp(), method, path, { permission: [] }));
    await expectForwarded(await send(makeApp(), method, path, { title: "t" }));
  });

  it("refuses adding an MCP server", async () => {
    await expectRefused(await send(makeApp(), "POST", "/mcp", { name: "m", config: {} }));
  });

  it("forwards connecting a configured MCP server", async () => {
    await expectForwarded(await send(makeApp(), "POST", "/mcp/m/connect"));
  });
});

describe("shell enabled (1.x)", () => {
  it("forwards everything", async () => {
    const app = makeApp(true);
    await expectForwarded(await command(app, { command: "init", arguments: "!`id`", parts: [] }));
    await expectForwarded(await send(app, "POST", "/experimental/worktree", { startCommand: "echo marker" }));
    await expectForwarded(await send(app, "PATCH", "/project/prj_1", { commands: { start: "echo marker" } }));
    await expectForwarded(await send(app, "PATCH", "/global/config", { shell: "/bin/zsh", permission: {} }));
    await expectForwarded(await send(app, "POST", "/mcp", { name: "m", config: {} }));
    await expectForwarded(await send(app, "POST", "/session", { permission: [] }));
  });
});
