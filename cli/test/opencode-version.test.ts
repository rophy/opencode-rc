import { describe, it, expect } from "vitest";
import { parseOpencodeVersion, detectOpencodeVersion, classifyOpencodeVersion } from "../src/opencode-version.js";

describe("parseOpencodeVersion", () => {
  it("reads the 1.x output", () => {
    expect(parseOpencodeVersion("1.18.29\n")).toBe("1.18.29");
  });
  it("reads the 2.x output", () => {
    expect(parseOpencodeVersion("opencode v2.0.26\n")).toBe("2.0.26");
  });
  it("rejects output without a version", () => {
    expect(parseOpencodeVersion("")).toBeNull();
    expect(parseOpencodeVersion("opencode dev")).toBeNull();
  });
});

describe("classifyOpencodeVersion", () => {
  it("supports 1.x", () => {
    expect(classifyOpencodeVersion("1.18.29\n")).toEqual({ kind: "supported", version: "1.18.29" });
  });
  it("asks for a newer opencode-rc on 2.x", () => {
    expect(classifyOpencodeVersion("opencode v2.0.26\n")).toEqual({ kind: "needs-newer-cli", version: "2.0.26" });
  });
  it("rejects 3.x", () => {
    expect(classifyOpencodeVersion("3.1.0")).toEqual({ kind: "unsupported", version: "3.1.0" });
  });
  it("treats a source build as unknown", () => {
    expect(classifyOpencodeVersion("local\n")).toEqual({ kind: "unknown" });
  });
  it("treats a snapshot as unknown", () => {
    expect(classifyOpencodeVersion("0.0.0-dev-202610110000")).toEqual({ kind: "unknown" });
  });
});

describe("detectOpencodeVersion", () => {
  it("returns the raw output", () => {
    expect(detectOpencodeVersion(() => "1.18.29\n")).toBe("1.18.29\n");
  });
  it("explains a missing opencode", () => {
    expect(() =>
      detectOpencodeVersion(() => {
        throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      }),
    ).toThrow(/opencode is not installed or not on PATH/);
  });
  it("explains a failing opencode", () => {
    expect(() =>
      detectOpencodeVersion(() => {
        throw new Error("boom");
      }),
    ).toThrow(/could not run "opencode --version": boom/);
  });
});
