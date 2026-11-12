import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CLI_VERSION, wantsVersion } from "../src/version.js";

describe("CLI_VERSION", () => {
  it("is the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(CLI_VERSION).toBe(pkg.version);
  });
});

describe("wantsVersion", () => {
  it("accepts --version and -v", () => {
    expect(wantsVersion(["--version"])).toBe(true);
    expect(wantsVersion(["-v"])).toBe(true);
  });
  it("ignores other arguments", () => {
    expect(wantsVersion([])).toBe(false);
    expect(wantsVersion(["--verbose"])).toBe(false);
  });
});
