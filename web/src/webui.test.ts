import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSpaFile } from "./webui.js";

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

  it("returns null when the UI is missing", () => {
    expect(resolveSpaFile(join(dir, "nope"), "/")).toBeNull();
  });
});
