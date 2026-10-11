import { describe, it, expect } from "vitest";
import { parseOpencodeVersion, detectOpencodeVersion } from "../src/opencode-version.js";

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

describe("detectOpencodeVersion", () => {
  it("returns the parsed version", () => {
    expect(detectOpencodeVersion(() => "1.18.29\n")).toBe("1.18.29");
  });
  it("explains a missing opencode", () => {
    expect(() =>
      detectOpencodeVersion(() => {
        throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      }),
    ).toThrow(/opencode is not installed or not on PATH/);
  });
  it("explains unreadable output", () => {
    expect(() => detectOpencodeVersion(() => "opencode dev")).toThrow(/could not read the opencode version/);
  });
});
