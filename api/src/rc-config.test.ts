import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, FEATURES, FEATURES_V2, parseConfig, parseConfigText } from "../../config/schema.js";
import { loadRcConfig } from "./rc-config.js";

const ALL_ON = {
  features: Object.fromEntries(FEATURES.map((name) => [name, { enabled: true }])),
  opencodeV2: { features: Object.fromEntries(FEATURES_V2.map((name) => [name, { enabled: true }])) },
};

describe("parseConfig", () => {
  it("enables every feature for an empty object", () => {
    expect(parseConfig({})).toEqual(ALL_ON);
  });

  it("reads serverUrl and strips trailing slashes", () => {
    expect(parseConfig({ serverUrl: "https://rc-api.example.com//" })).toEqual({
      serverUrl: "https://rc-api.example.com",
      ...ALL_ON,
    });
  });

  it("keeps a path in serverUrl", () => {
    expect(parseConfig({ serverUrl: "http://gw.example.com/rc/" }).serverUrl).toBe("http://gw.example.com/rc");
  });

  it("drops surrounding spaces from serverUrl", () => {
    expect(parseConfig({ serverUrl: " https://x.example.com/ " }).serverUrl).toBe("https://x.example.com");
  });

  it("disables uploads", () => {
    expect(parseConfig({ features: { uploads: { enabled: false } } })).toEqual({
      ...ALL_ON,
      features: { ...ALL_ON.features, uploads: { enabled: false } },
    });
  });

  it("enables every 2.x feature by default", () => {
    expect(Object.keys(parseConfig({}).opencodeV2.features)).toEqual(["uploads", "terminal", "shell", "export"]);
    expect(Object.values(parseConfig({}).opencodeV2.features).every((f) => f.enabled)).toBe(true);
  });

  it("disables only the named 2.x feature", () => {
    const { opencodeV2, features } = parseConfig({ opencodeV2: { features: { terminal: { enabled: false } } } });
    expect(opencodeV2.features).toEqual({ ...ALL_ON.opencodeV2.features, terminal: { enabled: false } });
    expect(features).toEqual(ALL_ON.features);
  });

  it("keeps 1.x and 2.x toggles independent", () => {
    const cfg = parseConfig({ features: { uploads: { enabled: false } } });
    expect(cfg.features.uploads.enabled).toBe(false);
    expect(cfg.opencodeV2.features.uploads.enabled).toBe(true);
  });

  it("treats a feature object without enabled as enabled", () => {
    expect(parseConfig({ features: { uploads: {} } })).toEqual(ALL_ON);
  });

  it.each([
    [{ serverURL: "https://x.example.com" }, 'unknown key "serverURL"'],
    [{ features: { upload: { enabled: false } } }, 'unknown key "features.upload"'],
    [{ features: { uploads: { enable: false } } }, 'unknown key "features.uploads.enable"'],
    [{ features: { uploads: false } }, "features.uploads must be an object"],
    [{ features: { uploads: { enabled: "no" } } }, "features.uploads.enabled must be true or false"],
    [{ features: [] }, "features must be an object"],
    [{ opencodeV2: { features: { share: { enabled: false } } } }, 'unknown key "opencodeV2.features.share"'],
    [{ opencodeV2: { other: 1 } }, 'unknown key "opencodeV2.other"'],
    [{ opencodeV2: [] }, "opencodeV2 must be an object"],
    [{ opencodeV2: { features: [] } }, "opencodeV2.features must be an object"],
    [{ opencodeV2: { features: { shell: { enabled: "no" } } } }, "opencodeV2.features.shell.enabled must be true or false"],
    [{ serverUrl: 42 }, "serverUrl must be a string"],
    [{ serverUrl: "not a url" }, "serverUrl is not a valid URL"],
    [{ serverUrl: "ftp://x.example.com" }, "serverUrl must start with http:// or https://"],
    [{ serverUrl: "https://x.example.com/?a=1" }, "serverUrl must not have a query or fragment"],
    [[], "must be a JSON object"],
    [null, "must be a JSON object"],
  ])("rejects %j", (raw, message) => {
    expect(() => parseConfig(raw, "cfg.json")).toThrow(ConfigError);
    expect(() => parseConfig(raw, "cfg.json")).toThrow(`cfg.json: ${message}`);
  });
});

describe("parseConfigText", () => {
  it("parses JSON text", () => {
    expect(parseConfigText('{"features":{"uploads":{"enabled":false}}}').features.uploads.enabled).toBe(false);
  });

  it.each(["", "{", "{} trailing"])("rejects %j as invalid JSON", (text) => {
    expect(() => parseConfigText(text, "cfg.json")).toThrow(/^cfg\.json: not valid JSON/);
  });
});

describe("loadRcConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-config-"));
  afterEach(() => {
    delete process.env.OPENCODE_RC_CONFIG;
  });

  it("enables every feature without a file", () => {
    expect(loadRcConfig(undefined)).toEqual(ALL_ON);
  });

  it("reads the file named by OPENCODE_RC_CONFIG", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, '{"serverUrl":"https://ignored.example.com","features":{"uploads":{"enabled":false}}}');
    process.env.OPENCODE_RC_CONFIG = file;
    expect(loadRcConfig().features.uploads.enabled).toBe(false);
  });

  it("fails for a missing file", () => {
    expect(() => loadRcConfig(join(dir, "nope.json"))).toThrow(/ENOENT/);
  });

  it("fails for an invalid file, naming it", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, '{"features":{"uploads":{"enabled":"off"}}}');
    expect(() => loadRcConfig(file)).toThrow(`${file}: features.uploads.enabled must be true or false`);
  });
});
