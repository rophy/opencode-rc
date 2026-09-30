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

// Serves /auth/cli-config as given; other URLs return OIDC discovery.
function stubServer(cliConfig: { status?: number; body?: unknown; error?: Error }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/cli-config")) {
      if (cliConfig.error) throw cliConfig.error;
      const status = cliConfig.status ?? 200;
      return { ok: status < 300, status, json: () => Promise.resolve(cliConfig.body) };
    }
    return { ok: true, json: () => Promise.resolve(OIDC_DISCOVERY) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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
        gatewayUrl: "https://gateway.example.com",
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
    expect(config.gatewayUrl).toBe("https://gateway.example.com");
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
    stubServer({ status: 404 });

    await expect(loadConfig()).rejects.toThrow("OIDC_ISSUER is required");
  });

  it("throws when oidc client ID is missing", async () => {
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_ISSUER: "http://mock-issuer",
    });
    stubServer({ status: 404 });

    await expect(loadConfig()).rejects.toThrow("OIDC_CLIENT_ID is required");
  });

  it("fetches issuer and client ID from the server when unset", async () => {
    setEnv({ OPENCODE_RC_GATEWAY_URL: "https://gw.example.com/" });
    const fetchMock = stubServer({ body: { issuer: "http://mock-issuer", clientId: "server-cli" } });

    const config = await loadConfig();
    expect(fetchMock).toHaveBeenCalledWith("https://gw.example.com/auth/cli-config");
    expect(config.oidcIssuer).toBe("http://mock-issuer");
    expect(config.oidcClientID).toBe("server-cli");
    expect(config.oidcTokenEndpoint).toBe("http://mock-issuer/token");
  });

  it("local values win over the server", async () => {
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_CLIENT_ID: "local-cli",
    });
    stubServer({ body: { issuer: "http://mock-issuer", clientId: "server-cli" } });

    const config = await loadConfig();
    expect(config.oidcIssuer).toBe("http://mock-issuer");
    expect(config.oidcClientID).toBe("local-cli");
  });

  it("does not call the server when issuer and client ID are set", async () => {
    setEnv({
      OPENCODE_RC_GATEWAY_URL: "https://gw.example.com",
      OIDC_ISSUER: "http://mock-issuer",
      OIDC_CLIENT_ID: "my-client",
    });
    const fetchMock = stubServer({ body: {} });

    await loadConfig();
    expect(fetchMock).not.toHaveBeenCalledWith("https://gw.example.com/auth/cli-config");
  });

  it("throws when the server is unreachable and issuer is unset", async () => {
    setEnv({ OPENCODE_RC_GATEWAY_URL: "https://gw.example.com" });
    stubServer({ error: new Error("ECONNREFUSED") });

    await expect(loadConfig()).rejects.toThrow(/OIDC_ISSUER is required.*not provided by the server/);
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
