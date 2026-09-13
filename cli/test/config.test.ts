import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `opencode-rc-test-${process.pid}`);
const configDir = join(testDir, "opencode");
const configPath = join(configDir, "rc.json");

const OIDC_DISCOVERY = {
  token_endpoint: "http://mock-issuer/token",
  authorization_endpoint: "http://mock-issuer/authorize",
};

beforeEach(async () => {
  await mkdir(configDir, { recursive: true });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(OIDC_DISCOVERY),
    })
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(testDir, { recursive: true, force: true });
});

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: testDir,
    OPENCODE_RC_GATEWAY_URL: undefined,
    OIDC_ISSUER: undefined,
    OIDC_CLIENT_ID: undefined,
    OIDC_CLIENT_SECRET: undefined,
    OIDC_TOKEN_ENDPOINT: undefined,
    OIDC_AUTHORIZATION_ENDPOINT: undefined,
    OIDC_CALLBACK_PORTS: undefined,
    OPENCODE_RC_TOKEN: undefined,
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      vi.stubEnv(k, v);
    }
  }
}

describe("loadConfig", () => {
  it("loads all values from config file", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        gatewayUrl: "https://gw.example.com",
        oidc: {
          issuer: "http://mock-issuer",
          clientId: "my-client",
          clientSecret: "my-secret",
          callbackPorts: [8400, 8401],
        },
      })
    );
    setEnv();

    const config = await loadConfig();
    expect(config.gatewayUrl).toBe("https://gw.example.com");
    expect(config.oidcIssuer).toBe("http://mock-issuer");
    expect(config.oidcClientID).toBe("my-client");
    expect(config.oidcClientSecret).toBe("my-secret");
    expect(config.oidcCallbackPorts).toEqual([8400, 8401]);
    expect(config.oidcTokenEndpoint).toBe("http://mock-issuer/token");
    expect(config.oidcAuthorizationEndpoint).toBe("http://mock-issuer/authorize");
  });

  it("env vars override config file", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        gatewayUrl: "https://file-gw.example.com",
        oidc: {
          issuer: "http://file-issuer",
          clientId: "file-client",
          clientSecret: "file-secret",
        },
      })
    );
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://env-gw.example.com",
      OIDC_ISSUER: "http://mock-issuer",
      OIDC_CLIENT_ID: "env-client",
      OIDC_CLIENT_SECRET: "env-secret",
    });

    const config = await loadConfig();
    expect(config.gatewayUrl).toBe("https://env-gw.example.com");
    expect(config.oidcClientID).toBe("env-client");
    expect(config.oidcClientSecret).toBe("env-secret");
  });

  it("works with env vars only (no config file)", async () => {
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_ISSUER: "http://mock-issuer",
      OIDC_CLIENT_ID: "my-client",
    });
    await rm(configPath, { force: true });

    const config = await loadConfig();
    expect(config.gatewayUrl).toBe("https://gw.example.com");
    expect(config.oidcClientID).toBe("my-client");
    expect(config.oidcClientSecret).toBeUndefined();
  });

  it("throws when gatewayUrl is missing", async () => {
    setEnv({
      OIDC_ISSUER: "http://mock-issuer",
      OIDC_CLIENT_ID: "my-client",
    });

    await expect(loadConfig()).rejects.toThrow("OPENCODE_RC_GATEWAY_URL is required");
  });

  it("throws when oidc issuer is missing", async () => {
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_CLIENT_ID: "my-client",
    });

    await expect(loadConfig()).rejects.toThrow("OIDC_ISSUER is required");
  });

  it("throws when oidc client ID is missing", async () => {
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_ISSUER: "http://mock-issuer",
    });

    await expect(loadConfig()).rejects.toThrow("OIDC_CLIENT_ID is required");
  });

  it("parses OIDC_CALLBACK_PORTS from env", async () => {
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_ISSUER: "http://mock-issuer",
      OIDC_CLIENT_ID: "my-client",
      OIDC_CALLBACK_PORTS: "8400, 8401, 8402",
    });

    const config = await loadConfig();
    expect(config.oidcCallbackPorts).toEqual([8400, 8401, 8402]);
  });

  it("ignores malformed config file", async () => {
    await writeFile(configPath, "not json{{{");
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_ISSUER: "http://mock-issuer",
      OIDC_CLIENT_ID: "my-client",
    });

    const config = await loadConfig();
    expect(config.gatewayUrl).toBe("https://gw.example.com");
  });
});
