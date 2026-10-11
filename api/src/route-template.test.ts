import { describe, it, expect } from "vitest";
import { templateRegex } from "./route-template.js";

describe("templateRegex", () => {
  it("matches one segment per parameter", () => {
    const re = templateRegex("/api/session/:sessionID/prompt");
    expect(re.test("/api/session/abc/prompt")).toBe(true);
    expect(re.test("/api/session/a/b/prompt")).toBe(false);
    expect(re.test("/api/session//prompt")).toBe(false);
    expect(re.test("/api/session/abc/prompt/x")).toBe(false);
  });
  it("matches the rest of the path for a trailing *", () => {
    const re = templateRegex("/api/fs/read/*");
    expect(re.test("/api/fs/read/src/a.ts")).toBe(true);
    expect(re.test("/api/fs/read/")).toBe(false);
  });
  it("is lower-case, for canonical paths", () => {
    expect(templateRegex("/api/session/:sessionID").test("/api/session/x")).toBe(true);
    expect(templateRegex("/api/experimental/session/import").source).toBe(templateRegex("/api/experimental/session/import").source.toLowerCase());
  });
});
