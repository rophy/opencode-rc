import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { isReservedPath, reservedNotFound, resolveSpaFile } from "./webui.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "webui-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
});

describe("resolveSpaFile", () => {
  it("serves existing files", () => {
    expect(resolveSpaFile(dir, "/assets/app.js")).toBe(join(dir, "assets", "app.js"));
  });

  it("falls back to index.html for client routes", () => {
    expect(resolveSpaFile(dir, "/s/alice-dev/")).toBe(join(dir, "index.html"));
    expect(resolveSpaFile(dir, "/s/alice-dev/abc/session/ses_1")).toBe(join(dir, "index.html"));
    expect(resolveSpaFile(dir, "/")).toBe(join(dir, "index.html"));
  });

  it("does not escape the UI directory", () => {
    expect(resolveSpaFile(dir, "/../../etc/passwd")).toBe(join(dir, "index.html"));
  });

  it("falls back to index.html on malformed percent-encoding", () => {
    expect(resolveSpaFile(dir, "/%")).toBe(join(dir, "index.html"));
  });

  it("returns null when the UI is missing", () => {
    expect(resolveSpaFile(join(dir, "nope"), "/")).toBeNull();
  });
});

describe("reserved API paths", () => {
  it("recognises API prefixes only", () => {
    for (const p of ["/api", "/api/nope", "/auth/x", "/gateway/x", "/proxy/abc/x"]) {
      expect(isReservedPath(p)).toBe(true);
    }
    for (const p of ["/", "/s/abc/", "/assets/app.js", "/apix", "/authors", "/proxyfoo"]) {
      expect(isReservedPath(p)).toBe(false);
    }
  });

  it("answers unknown API paths with a JSON 404 and lets SPA routes through", async () => {
    const app = new Hono();
    app.get("/api/me", (c) => c.json({ ok: true }));
    app.all("*", reservedNotFound());
    app.get("*", (c) => c.text("spa"));

    const miss = await app.request("/api/nope");
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "not found" });
    expect((await app.request("/proxy/x", { method: "POST" })).status).toBe(404);
    expect((await app.request("/auth/nope")).status).toBe(404);
    expect((await app.request("/gateway/nope")).status).toBe(404);

    expect(await (await app.request("/api/me")).json()).toEqual({ ok: true });
    expect(await (await app.request("/s/abc/")).text()).toBe("spa");
    expect(await (await app.request("/")).text()).toBe("spa");
  });
});
