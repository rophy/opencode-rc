import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { parseConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { v2Guard, v2Guards } from "./v2-guard.js";

const meta = { id: "s", userId: "u", directory: "/w", gatewayAddr: "gw:9090", createdAt: "", opencodeVersion: "2.0.26" };
const info = async () => ({ paths: { tmp: "/tmp/oc" } });

const cfg = (features: Record<string, { enabled: boolean }> = {}) => parseConfig({ opencodeV2: { features } });

function makeApp(config = cfg(), fetchServerInfo: (() => Promise<unknown>) | undefined = info) {
  const app = new Hono<ProxyEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "u");
    c.set("token", "t");
    c.set("session", meta as never);
    await next();
  });
  const guard = v2Guard(config.opencodeV2.features, { fetchServerInfo: fetchServerInfo as never });
  app.all("/proxy/:sessionId/*", guard, (c) => {
    const body = c.get("body");
    return c.text(`forwarded${body ? " " + new TextDecoder().decode(body) : ""}`);
  });
  return app;
}

const call = (app: Hono<ProxyEnv>, method: string, path: string, body?: unknown) =>
  app.request(`/proxy/s${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

async function expectRejected(res: Response, message?: RegExp) {
  expect(res.status).toBe(400);
  const json = (await res.json()) as { _tag: string; message: string };
  expect(json._tag).toBe("FeatureDisabled");
  expect(json.message.length).toBeGreaterThan(0);
  if (message) expect(json.message).toMatch(message);
}
const expectForwarded = async (res: Response) => expect(await res.text()).toMatch(/^forwarded/);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("v2 uploads disabled: both body shapes", () => {
  const app = () => makeApp(cfg({ uploads: { enabled: false } }));
  const data = { uri: "data:image/png;base64,AA" };
  const file = { uri: "file:///w/a.ts" };
  it("rejects data in files and in prompt.files, for prompt and command", async () => {
    for (const route of ["prompt", "command"]) {
      await expectRejected(await call(app(), "POST", `/api/session/x/${route}`, { files: [data] }), /uploads/);
      await expectRejected(await call(app(), "POST", `/api/session/x/${route}`, { prompt: { files: [data] } }), /uploads/);
    }
  });
  it("passes file: entries in either shape", async () => {
    await expectForwarded(await call(app(), "POST", "/api/session/x/prompt", { prompt: { files: [file] } }));
    await expectForwarded(await call(app(), "POST", "/api/session/x/prompt", { files: [file] }));
  });
});

describe("v2 downloads disabled: file attachments", () => {
  const off = (features: Record<string, { enabled: boolean }> = {}) => makeApp(cfg({ downloads: { enabled: false }, ...features }));
  const data = { uri: "data:image/png;base64,AA" };
  it.each([
    { uri: "file:///w/opencode.json" },
    { uri: "FILE:///etc/passwd" },
    { uri: " file:///etc/passwd" },
    { uri: "file:///w/src?start=1&end=3" },
    { uri: "https://example.com/a.png" },
    { uri: "DATA:text/plain,a" },
    { uri: 1 },
    "file:///w/a",
  ])("rejects %j in files and in prompt.files, for prompt and command", async (file) => {
    for (const route of ["prompt", "command"]) {
      await expectRejected(await call(off(), "POST", `/api/session/x/${route}`, { text: "hi", files: [file] }), /^file downloads are disabled$/);
      await expectRejected(await call(off(), "POST", `/api/session/x/${route}`, { prompt: { text: "hi", files: [file] } }), /^file downloads are disabled$/);
    }
  });
  it("passes text-only prompts, agents and skills, and data: while uploads are enabled", async () => {
    const body = { text: "look at @src/a.ts", agents: [{ name: "general" }], skills: [{ id: "s" }], files: [] };
    const res = await call(off(), "POST", "/api/session/x/prompt", body);
    expect(await res.text()).toBe(`forwarded ${JSON.stringify(body)}`);
    await expectForwarded(await call(off(), "POST", "/api/session/x/command", { name: "review", text: "@src/a.ts" }));
    await expectForwarded(await call(off(), "POST", "/api/session/x/prompt", { text: "hi", files: [data] }));
  });
  it("with uploads also disabled, refuses every attachment", async () => {
    const both = () => off({ uploads: { enabled: false } });
    await expectRejected(await call(both(), "POST", "/api/session/x/prompt", { text: "", files: [data] }), /uploads/);
    await expectRejected(await call(both(), "POST", "/api/session/x/prompt", { text: "", files: [{ uri: "file:///w/a" }] }), /downloads/);
    await expectForwarded(await call(both(), "POST", "/api/session/x/prompt", { text: "hi" }));
  });
  it("passes file: attachments while enabled", async () => {
    await expectForwarded(await call(makeApp(), "POST", "/api/session/x/prompt", { text: "", files: [{ uri: "file:///w/a" }] }));
  });
  it("rejects a non-JSON prompt", async () => {
    await expectRejected(await call(off(), "POST", "/api/session/x/prompt", "not json"), /not JSON/);
  });
});

describe("v2 shell disabled: command text", () => {
  const off = (features: Record<string, { enabled: boolean }> = {}) => makeApp(cfg({ shell: { enabled: false }, ...features }));
  it.each(["!`echo marker`", "review !`id", 'HEAD "!`id`"', "wow!", "! `id`", '"a!" "`id`"'])("rejects a command whose text is %j", async (text) => {
    await expectRejected(await call(off(), "POST", "/api/session/x/command", { name: "review", text }), /^shell commands are disabled$/);
  });
  it.each(["HEAD~1", "!nice", "`code` here", "a!b", ""])("forwards a command whose text is %j", async (text) => {
    const body = { name: "review", text };
    expect(await (await call(off(), "POST", "/api/session/x/command", body)).text()).toBe(`forwarded ${JSON.stringify(body)}`);
  });
  it("leaves prompts alone (their text is not interpolated)", async () => {
    await expectForwarded(await call(off(), "POST", "/api/session/x/prompt", { text: "!`id`" }));
  });
  it("with uploads, downloads and shell off, each rejects its own case and a clean command passes intact", async () => {
    const all = () => off({ uploads: { enabled: false }, downloads: { enabled: false } });
    const route = "/api/session/x/command";
    await expectRejected(await call(all(), "POST", route, { name: "r", text: "!`id`" }), /shell/);
    await expectRejected(await call(all(), "POST", route, { name: "r", text: "", files: [{ uri: "data:text/plain,a" }] }), /uploads/);
    await expectRejected(await call(all(), "POST", route, { name: "r", text: "", files: [{ uri: "file:///w/a" }] }), /downloads/);
    const body = { name: "r", text: "HEAD wow `code`", agents: [{ name: "general" }] };
    expect(await (await call(all(), "POST", route, body)).text()).toBe(`forwarded ${JSON.stringify(body)}`);
  });
  it("forwards !`cmd` while shell is enabled", async () => {
    await expectForwarded(await call(makeApp(), "POST", "/api/session/x/command", { name: "review", text: "!`id`" }));
  });
  it("rejects a non-JSON command body", async () => {
    await expectRejected(await call(off(), "POST", "/api/session/x/command", "not json"), /not JSON/);
  });
});

describe("v2Guard", () => {
  it("1: forwards allowed routes, case-insensitively", async () => {
    const app = makeApp();
    await expectForwarded(await call(app, "GET", "/api/session"));
    await expectForwarded(await call(app, "GET", "/api/fs/read/src/a.ts"));
    await expectForwarded(await call(app, "GET", "/API/Session"));
  });

  it("2: rejects 1.x legacy and unknown paths", async () => {
    const app = makeApp();
    await expectRejected(await call(app, "GET", "/session"));
    await expectRejected(await call(app, "GET", "/unknown"));
  });

  it("3: rejects never routes", async () => {
    const app = makeApp();
    for (const [m, p] of [
      ["POST", "/api/shell"],
      ["PATCH", "/api/experimental/config"],
      ["POST", "/api/pair"],
      ["GET", "/auth/connect/abc"],
      ["PUT", "/api/experimental/mcp/x"],
      ["POST", "/api/integration/i/connect/external"],
      ["GET", "/api/experimental/persistent-pty/p"],
    ]) {
      await expectRejected(await call(app, m, p));
    }
  });

  it("4: terminal toggle", async () => {
    const on = makeApp();
    await expectForwarded(await call(on, "POST", "/api/pty"));
    await expectForwarded(await call(on, "GET", "/api/pty/p/connect"));
    const off = makeApp(cfg({ terminal: { enabled: false } }));
    await expectRejected(await call(off, "POST", "/api/pty"), /terminal/);
    await expectRejected(await call(off, "GET", "/api/pty/p/connect"), /terminal/);
  });

  it("5: shell toggle", async () => {
    await expectRejected(await call(makeApp(cfg({ shell: { enabled: false } })), "POST", "/api/session/x/shell"));
    await expectForwarded(await call(makeApp(), "POST", "/api/session/x/shell"));
  });

  it("6: export toggle", async () => {
    await expectRejected(await call(makeApp(cfg({ export: { enabled: false } })), "GET", "/api/experimental/session/x/export"));
    await expectForwarded(await call(makeApp(), "GET", "/api/experimental/session/x/export"));
  });

  it("7: project commands are never changeable", async () => {
    for (const app of [makeApp(), makeApp(cfg({ uploads: { enabled: false } }))]) {
      const res = await call(app, "PATCH", "/api/project/p", { name: "x" });
      expect(await res.text()).toBe('forwarded {"name":"x"}');
      await expectRejected(await call(app, "PATCH", "/api/project/p", { commands: { start: "rm -rf ~" } }));
    }
  });

  it("8: uploads disabled", async () => {
    const app = makeApp(cfg({ uploads: { enabled: false } }));
    await expectRejected(await call(app, "POST", "/api/experimental/fs/write?path=/tmp/oc/uploads/u/f.txt"));
    await expectRejected(await call(app, "POST", "/api/experimental/session/import"));
    const data = { files: [{ uri: "data:image/png;base64,AA" }] };
    await expectRejected(await call(app, "POST", "/api/session/x/prompt", data));
    await expectForwarded(await call(app, "POST", "/api/session/x/prompt", { files: [{ uri: "file:///w/a.ts" }] }));
    await expectForwarded(await call(app, "POST", "/api/session/x/prompt", { text: "hi" }));
    await expectRejected(await call(app, "POST", "/api/session/x/command", data));
    await expectRejected(await call(app, "PATCH", "/api/project/p", { icon: { override: "data:image/png;base64,AA" } }));
  });

  it("9: fs/write with uploads enabled", async () => {
    const app = makeApp();
    const w = (q: string) => call(app, "POST", `/api/experimental/fs/write${q}`);
    await expectForwarded(await w("?path=/tmp/oc/uploads/u/f.txt"));
    await expectRejected(await w("?path=/home/u/.bashrc"));
    await expectRejected(await w("?path=/tmp/oc/uploads/../../etc/x"));
    await expectRejected(await w("?path=/tmp/ocx/uploads/u/f"));
    await expectRejected(await w(""));
    await expectRejected(await w("?path=/tmp/oc/uploads/a%5Cb"));
    await expectRejected(await w("?path=/tmp/oc/uploads/a%00b"));
    const bad = makeApp(cfg(), async () => {
      throw new Error("down");
    });
    await expectRejected(await call(bad, "POST", "/api/experimental/fs/write?path=/tmp/oc/uploads/u/f.txt"));
    const empty = makeApp(cfg(), async () => ({ paths: { tmp: "" } }));
    await expectRejected(await call(empty, "POST", "/api/experimental/fs/write?path=/uploads/f"));
    const slash = makeApp(cfg(), async () => ({ paths: { tmp: "/tmp/oc/" } }));
    await expectForwarded(await call(slash, "POST", "/api/experimental/fs/write?path=/tmp/oc/uploads/f"));
  });

  it("10: non-plain write paths get the FeatureDisabled 400", async () => {
    const app = new Hono<ProxyEnv>();
    app.use("*", async (c, next) => {
      c.set("userId", "u");
      c.set("session", meta as never);
      await next();
    });
    app.all("/proxy/:sessionId/*", v2Guards(cfg()), (c) => c.text("forwarded"));
    const res = await app.request("/proxy/s/api/session/a%2fb/prompt", { method: "POST" });
    await expectRejected(res, /unsupported characters/);
  });

  it("11: HEAD acts as GET, OPTIONS passes", async () => {
    const app = makeApp();
    expect((await call(app, "HEAD", "/api/session")).status).toBe(200);
    await expectForwarded(await call(app, "OPTIONS", "/api/anything"));
  });

  // The raw path is built with new Request so %3f %3b %5c reach the guard undecoded.
  it("12: rejects a path whose ? ; or \\ would change what is forwarded", async () => {
    const raw = (app: Hono<ProxyEnv>, path: string) => app.request(new Request(`http://localhost/proxy/s${path}`));
    const off = makeApp(cfg({ terminal: { enabled: false }, export: { enabled: false } }));
    await expectRejected(await raw(off, "/api/session%3f%5c..%5c..%5capi%5cexperimental%5cpersistent-pty%5cp%5cconnect"));
    await expectRejected(await raw(off, "/api/session%3b%5c..%5cpty%5cp%5cconnect"));
    await expectRejected(await raw(off, "/api/session%3f%5c..%5cexperimental%5csession%5cx%5cexport"));
    await expectRejected(await raw(off, "/api/session%23x"));
  });

  it("13: rejects paths that resolve differently once forwarded (space before .., encoded /)", async () => {
    const raw = (app: Hono<ProxyEnv>, path: string) => app.request(new Request(`http://localhost/proxy/s${path}`));
    const off = makeApp(cfg({ terminal: { enabled: false } }));
    await expectRejected(await raw(off, "/api/pty/p/connect/%20../.."));
    await expectRejected(await raw(off, "/api/pty/%20../.."));
    await expectRejected(await raw(makeApp(), "/api/integration/i/connect/command/a/x%2f..%2f..%2f../.."));
  });

  it("downloads toggle: only fs/read is refused", async () => {
    const off = makeApp(cfg({ downloads: { enabled: false } }));
    await expectRejected(await call(off, "GET", "/api/fs/read/src/a.ts"), /^file downloads are disabled$/);
    await expectForwarded(await call(off, "GET", "/api/fs/list"));
    await expectForwarded(await call(off, "GET", "/api/fs/find"));
    const on = makeApp();
    await expectForwarded(await call(on, "GET", "/api/fs/read/src/a.ts"));
    await expectForwarded(await call(on, "GET", "/api/fs/list"));
  });

  it("rejects a non-JSON body on a checked route", async () => {
    await expectRejected(await call(makeApp(), "PATCH", "/api/project/p", "not json"));
  });
});

describe("v2 session permission rules", () => {
  const rules = { permissions: [{ permission: "read", pattern: "*", action: "allow" }] };
  it.each([
    ["downloads", /downloads/],
    ["shell", /shell/],
  ])("are refused on session create and update while %s is off", async (feature, message) => {
    const app = makeApp(cfg({ [feature]: { enabled: false } }));
    await expectRejected(await call(app, "POST", "/api/session", rules), message);
    await expectRejected(await call(app, "PATCH", "/api/session/x", rules), message);
    await expectForwarded(await call(app, "POST", "/api/session", { title: "t" }));
    await expectForwarded(await call(app, "POST", "/api/session"));
  });
  it("names downloads when both are off", async () => {
    await expectRejected(await call(makeApp(cfg({ downloads: { enabled: false }, shell: { enabled: false } })), "POST", "/api/session", rules), /downloads/);
  });
  it("are forwarded while both are enabled", async () => {
    await expectForwarded(await call(makeApp(), "POST", "/api/session", rules));
  });
});
