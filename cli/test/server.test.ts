import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { startServer, type LocalServer } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-opencode-v2.mjs", import.meta.url));
const base = { command: process.execPath, prefixArgs: [fixture] };

const open: LocalServer[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  delete process.env.FAKE_MODE;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  vi.restoreAllMocks();
});

async function start(opts: Parameters<typeof startServer>[1] = {}) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const s = await startServer(2, { ...base, ...opts });
  open.push(s);
  return s;
}

describe("startServer(2)", () => {
  it("returns a url and an authorization the server accepts", async () => {
    const s = await start();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(s.authorization).toMatch(/^Basic /);
    expect((await fetch(s.url, { headers: { authorization: s.authorization! } })).status).toBe(200);
    expect((await fetch(s.url)).status).toBe(401);
  });

  it("does not pass OPENCODE_SERVER_PASSWORD to the child", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "leak";
    const s = await start();
    const r = await fetch(s.url + "/env", { headers: { authorization: s.authorization! } });
    expect(await r.json()).toEqual({ serverPassword: null });
  });

  it("close() ends stdin and the child exits", async () => {
    const s = await start();
    s.close();
    const deadline = Date.now() + 5000;
    let down = false;
    while (Date.now() < deadline && !down) {
      try {
        await fetch(s.url);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        down = true;
      }
    }
    expect(down).toBe(true);
  });

  it("rejects with the stderr tail when the server crashes", async () => {
    process.env.FAKE_MODE = "crash";
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(start()).rejects.toThrow(/boom/);
  });

  it("rejects on timeout and kills the child", async () => {
    process.env.FAKE_MODE = "silent";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(start({ timeoutMs: 300 })).rejects.toThrow(/timed out/i);
    const pid = Number(/pid (\d+)/.exec(err.mock.calls.map((c) => c.join(" ")).join("\n"))?.[1]);
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  });

  it("calls onExit when the server exits on its own", async () => {
    process.env.FAKE_MODE = "exit-later";
    const onExit = vi.fn();
    await start({ onExit });
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0, null), { timeout: 3000 });
  });

  it("does not call onExit after an intentional close()", async () => {
    const onExit = vi.fn();
    const s = await start({ onExit });
    s.close();
    await new Promise((r) => setTimeout(r, 1500));
    await expect(fetch(s.url)).rejects.toThrow();
    expect(onExit).not.toHaveBeenCalled();
  });
});
