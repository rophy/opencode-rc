import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";

// The always-refused 1.x routes, as v1Guards runs them in front of the proxy, with every
// feature enabled.
function makeApp() {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", v1Guards(parseConfig({})), (c) => c.text("forwarded"));
  return app;
}

const send = (method: string, path: string, body?: unknown) =>
  makeApp().request(`/proxy/alice-dev${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.text()).toBe("this opencode route is not available through opencode-rc");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("1.x routes refused whatever the toggles", () => {
  it.each(["/vcs/apply", "/VCS/Apply", "/vcs/apply/"])("refuses POST %s", async (path) => {
    await expectRefused(await send("POST", path, { patch: "diff --git a/README.md b/README.md\n" }));
  });

  it.each(["/global/upgrade", "/Global/Upgrade", "/global/upgrade/"])("refuses POST %s", async (path) => {
    await expectRefused(await send("POST", path, { target: "1.0.0" }));
  });

  it.each([
    ["POST", "/tui/append-prompt"],
    ["POST", "/tui/submit-prompt"],
    ["POST", "/tui/execute-command"],
    ["POST", "/TUI/show-toast/"],
    ["GET", "/tui/control/next"],
    ["GET", "/%74ui/control/next"],
    ["POST", "/tui/control/response"],
    ["GET", "/tui"],
  ])("refuses %s %s", async (method, path) => {
    await expectRefused(await send(method, path, method === "GET" ? undefined : {}));
  });

  it.each(["/log", "/LOG", "/log/"])("refuses POST %s", async (path) => {
    await expectRefused(await send("POST", path, { service: "x", level: "info", message: "hello" }));
  });

  it.each(["/sync/start", "/sync/steal", "/sync/history", "/Sync/History/"])("refuses POST %s", async (path) => {
    await expectRefused(await send("POST", path, {}));
  });

  it.each(["/experimental/console/switch", "/Experimental/Console/Switch/"])("refuses POST %s", async (path) => {
    await expectRefused(await send("POST", path, { accountID: "a", orgID: "o" }));
  });

  it.each([
    ["POST", "/experimental/workspace"],
    ["POST", "/experimental/workspace/"],
    ["POST", "/experimental/workspace/sync-list"],
    ["POST", "/experimental/workspace/warp"],
    ["DELETE", "/experimental/workspace/wrk_1"],
    ["DELETE", "/Experimental/Workspace/wrk_1/"],
  ])("refuses %s %s", async (method, path) => {
    await expectRefused(await send(method, path, method === "POST" ? {} : undefined));
  });

  it.each(["/experimental/control-plane/move-session", "/experimental/control-plane/move-session/"])("refuses POST %s", async (path) => {
    await expectRefused(await send("POST", path, { sessionID: "ses_1", workspaceID: "wrk_1" }));
  });

  // Routes next to the refused ones that the 1.x UI uses, or that only read.
  it.each([
    ["GET", "/vcs"],
    ["GET", "/vcs/status"],
    ["GET", "/vcs/diff"],
    ["GET", "/global/config"],
    ["GET", "/global/health"],
    ["POST", "/global/dispose"],
    ["POST", "/instance/dispose"],
    ["GET", "/experimental/console"],
    ["GET", "/experimental/console/orgs"],
    ["GET", "/experimental/workspace"],
    ["GET", "/experimental/workspace/status"],
    ["GET", "/experimental/workspace/adapter"],
    ["POST", "/experimental/worktree"],
    ["POST", "/sync/replay"],
    ["GET", "/session"],
    ["POST", "/project/git/init"],
  ])("forwards %s %s", async (method, path) => {
    expect(await (await send(method, path, method === "GET" ? undefined : {})).text()).toBe("forwarded");
  });
});
