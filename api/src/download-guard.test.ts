import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { ProxyEnv } from "./proxy.js";
import { v1Guards } from "./feature-guards.js";
import { downloadGuard, hasFileReference } from "./download-guard.js";
import { parseConfig } from "../../config/schema.js";

const off = parseConfig({ features: { downloads: { enabled: false } } });

// guard alone (so paths other guards reject still reach it) or the full v1 guard set
function makeApp(config: ReturnType<typeof parseConfig> | "alone" = off) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "alice@example.com");
    await next();
  });
  app.all("/proxy/:sessionId/*", config === "alone" ? downloadGuard() : v1Guards(config), (c) => c.text("forwarded"));
  return app;
}

const get = (app: Hono<ProxyEnv>, path: string, method = "GET") =>
  app.request(new Request(`http://localhost/proxy/s${path}`, { method }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("downloads disabled (1.x)", () => {
  it.each([
    "/file/content?path=a.ts",
    "/FILE/content?path=a.ts",
    "//file//content",
    "/%66ile/content?path=a.ts",
    "/file/content/",
    "/file/content//?path=a",
    "/find?pattern=x",
    "/find/",
    "/FIND?pattern=x",
    "/api/fs/read/src/a.ts",
    "/api/fs/read/a%20b.ts",
  ])("blocks GET %s", async (path) => {
    const res = await get(makeApp(), path);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("file downloads are disabled");
  });

  it.each(["/api/fs/read/", "/file/content/%2f", "/x/%2f", "/api/fs/read/src/%2e%2e%2fa"])("blocks GET %s (guard alone)", async (path) => {
    expect((await get(makeApp("alone"), path)).status).toBe(403);
  });

  it("blocks HEAD", async () => {
    expect((await get(makeApp(), "/file/content?path=a", "HEAD")).status).toBe(403);
    expect((await get(makeApp(), "/api/fs/read/a", "HEAD")).status).toBe(403);
  });

  it.each(["/file?path=src", "/find/file?query=a", "/find/file/", "/find/symbol?query=a", "/finder", "/api/fs/list", "/api/fs/find?query=a", "/session"])(
    "lets GET %s through",
    async (path) => {
      expect(await (await get(makeApp(), path)).text()).toBe("forwarded");
    },
  );

  it("leaves a non-GET to /file/content to the other guards", async () => {
    expect(await (await post(makeApp(), "/file/content", "{}")).text()).toBe("forwarded");
  });

  it("allows everything while enabled", async () => {
    const on = makeApp(parseConfig({}));
    expect(await (await get(on, "/file/content?path=a")).text()).toBe("forwarded");
    expect(await (await get(on, "/api/fs/read/a")).text()).toBe("forwarded");
    expect(await (await post(on, "/session/ses_1/message", { parts: [mention] })).text()).toBe("forwarded");
    expect(await (await post(on, "/session/ses_1/command", { command: "c", arguments: "@a.ts", parts: [] })).text()).toBe("forwarded");
  });
});

const text = { type: "text", text: "explain @src/a.ts to user@example.com" };
const mention = { type: "file", mime: "text/plain", filename: "opencode.json", url: "file:///project/opencode.json" };
const mcp = {
  type: "file",
  mime: "text/plain",
  filename: "doc",
  url: "file:///etc/passwd",
  source: { type: "resource", clientName: "docs", uri: "docs://a", text: { value: "", start: 0, end: 0 } },
};

function post(app: Hono<ProxyEnv>, path: string, body: unknown) {
  return app.request(new Request(`http://localhost/proxy/s${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

async function expectBlocked(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.text()).toBe("file downloads are disabled");
}

describe("hasFileReference", () => {
  it.each([
    ["@opencode.json", true],
    ["see @src/a.ts", true],
    ["@~/.ssh/id_rsa", true],
    ["@/etc/passwd", true],
    ["@.env", true],
    ["(@general)", true],
    ["user@example.com", false],
    ["`@a.ts`", false],
    ["a @ b", false],
    ["@", false],
    ["no mentions", false],
    [undefined, false],
    [1, false],
  ])("%j -> %s", (value, expected) => {
    expect(hasFileReference(value)).toBe(expected);
  });
});

describe("downloads disabled (1.x): prompts that read files", () => {
  const routes = ["/session/ses_1/message", "/session/ses_1/prompt_async", "/session/ses_1/command", "/SESSION/ses_1/Message", "/session/ses_1/message/"];

  it.each(routes)("blocks a file: part on %s, whatever its mime", async (route) => {
    for (const part of [
      mention,
      { ...mention, mime: "application/x-directory", url: "file:///project/src" },
      { ...mention, mime: "image/png" },
      { ...mention, url: "FILE:///etc/passwd" },
      { ...mention, url: " file:///etc/passwd" },
      { ...mention, url: "file:///project/a.ts?start=1&end=3" },
    ]) {
      await expectBlocked(await post(makeApp(), route, { parts: [text, part] }));
    }
  });

  it.each(routes)("blocks a subtask whose prompt references a path on %s", async (route) => {
    const subtask = { type: "subtask", prompt: "summarize @opencode.json", description: "d", agent: "general" };
    await expectBlocked(await post(makeApp(), route, { parts: [subtask] }));
  });

  it("blocks a command whose arguments reference a path", async () => {
    for (const args of ["@opencode.json", "look at @~/.ssh/id_rsa", "@/etc/passwd"]) {
      await expectBlocked(await post(makeApp(), "/session/ses_1/command", { command: "review", arguments: args, parts: [] }));
    }
  });

  it("blocks /api prompt files with a file: uri, in either shape", async () => {
    const file = { uri: "file:///project/opencode.json" };
    await expectBlocked(await post(makeApp(), "/api/session/ses_1/prompt", { prompt: { text: "", files: [file] } }));
    await expectBlocked(await post(makeApp(), "/api/session/ses_1/prompt", { files: [file] }));
    await expectBlocked(await post(makeApp(), "/API/session/ses_1/prompt/", { prompt: { text: "", files: [{ uri: "File:///a" }] } }));
  });

  it("forwards text, agent, MCP resource and data: parts, and commands without paths", async () => {
    const app = makeApp();
    const agent = { type: "agent", name: "general" };
    const data = { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" };
    const subtask = { type: "subtask", prompt: "mail user@example.com", description: "d", agent: "general" };
    expect(await (await post(app, "/session/ses_1/message", { parts: [text, agent, mcp, data, subtask] })).text()).toBe("forwarded");
    expect(await (await post(app, "/session/ses_1/command", { command: "review", arguments: "HEAD~1 user@example.com", parts: [] })).text()).toBe(
      "forwarded",
    );
    expect(await (await post(app, "/api/session/ses_1/prompt", { prompt: { text: "@a.ts", files: [{ uri: "data:text/plain,a" }] } })).text()).toBe(
      "forwarded",
    );
    expect(await (await post(app, "/session/ses_1/message", { parts: "not a list" })).text()).toBe("forwarded");
  });

  it("does not check other POST routes", async () => {
    expect(await (await post(makeApp(), "/session/ses_1/shell", { command: "@a.ts" })).text()).toBe("forwarded");
    expect(await (await post(makeApp(), "/session", { title: "@a.ts" })).text()).toBe("forwarded");
  });

  it("rejects a non-JSON body on a checked route", async () => {
    const res = await post(makeApp(), "/session/ses_1/message", "not json");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("request body is not JSON");
  });
});

describe("downloads disabled (1.x): template-completed references, stored parts, config", () => {
  it.each(["src/@", '"a@" "b"', "x @"])("blocks command arguments %j that end in @ (the template completes the path)", async (args) => {
    await expectBlocked(await post(makeApp(), "/session/ses_1/command", { command: "review", arguments: args, parts: [] }));
  });

  it("blocks stored parts and replays (a stored subtask runs and reads its @paths)", async () => {
    const subtask = { type: "subtask", prompt: "summarize @opencode.json", description: "d", agent: "general" };
    const patch = await makeApp().request("/proxy/s/session/ses_1/message/msg_1/part/prt_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subtask),
    });
    await expectBlocked(patch);
    await expectBlocked(await post(makeApp(), "/sync/replay", { events: [] }));
  });

  it.each(["/config", "/global/config", "/GLOBAL/config/"])("blocks {file:} substitution, instructions and permission rules on PATCH %s", async (path) => {
    const patch = (body: unknown) =>
      makeApp().request(`/proxy/s${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await expectBlocked(await patch({ provider: { p: { options: { apiKey: "{file:~/.ssh/id_rsa}" } } } }));
    await expectBlocked(await patch({ provider: { p: { options: { headers: { x: "a{FILE:/etc/hosts}" } } } } }));
    await expectBlocked(await patch({ provider: { "{file:/etc/hosts}": {} } }));
    await expectBlocked(await patch({ disabled_providers: ["{file:/etc/hosts}"] }));
    await expectBlocked(await patch({ instructions: ["notes.md"] }));
    await expectBlocked(await patch({ permission: { read: "allow" } }));
    await expectBlocked(await patch({ tools: { read: true } }));
    expect(await (await patch({ disabled_providers: ["anthropic"], provider: { p: { options: { apiKey: "{env:KEY}" } } } })).text()).toBe("forwarded");
  });

  it.each([
    ["POST", "/session"],
    ["PATCH", "/session/ses_1"],
  ])("blocks session permission rules on %s %s", async (method, path) => {
    const req = (body: unknown) =>
      makeApp().request(`/proxy/s${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await expectBlocked(await req({ permission: [{ permission: "read", pattern: "*", action: "allow" }] }));
    expect(await (await req({ title: "t" })).text()).toBe("forwarded");
  });

  it.each(["message", "prompt_async"])("blocks tools (session permission rules) on POST /session/:id/%s", async (route) => {
    const prompt = { parts: [{ type: "text", text: "hello" }] };
    await expectBlocked(await post(makeApp(), `/session/ses_1/${route}`, { ...prompt, tools: { read: true } }));
    expect(await (await post(makeApp(), `/session/ses_1/${route}`, prompt)).text()).toBe("forwarded");
  });

  it("forwards all of these while downloads are enabled", async () => {
    const app = makeApp(parseConfig({}));
    expect(await (await post(app, "/session/ses_1/command", { command: "review", arguments: "src/@", parts: [] })).text()).toBe("forwarded");
    expect(await (await post(app, "/sync/replay", { events: [] })).text()).toBe("forwarded");
    const config = await app.request("/proxy/s/global/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: ["a.md"], provider: { p: { options: { apiKey: "{file:k}" } } } }),
    });
    expect(await config.text()).toBe("forwarded");
  });
});
