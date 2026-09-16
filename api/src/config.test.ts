import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./config.js";

const validEnv: Record<string, string> = {
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_CLIENT_ID: "my-client",
  OIDC_REDIRECT_URI: "https://app.example.com/auth/callback",
  COOKIE_SECRET: "ab".repeat(32),
  REDIS_URL: "redis://localhost:6379/0",
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of Object.keys(validEnv)) {
    saved[key] = process.env[key];
  }
  for (const [k, v] of Object.entries(validEnv)) {
    process.env[k] = v;
  }
  delete process.env.PORT;
  delete process.env.WEBUI_DIR;
  delete process.env.GATEWAY_URL;
  delete process.env.COOKIE_DOMAIN;
  delete process.env.COOKIE_SECURE;
  delete process.env.TLS_INSECURE_SKIP_VERIFY;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_CLI_CLIENT_ID;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadConfig", () => {
  it("loads required fields from env", () => {
    const config = loadConfig();
    expect(config.oidcIssuer).toBe("https://idp.example.com");
    expect(config.oidcClientId).toBe("my-client");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
    expect(config.cookieSecret).toBeInstanceOf(Uint8Array);
    expect(config.cookieSecret.length).toBe(32);
  });

  it("defaults port to 8080", () => {
    const config = loadConfig();
    expect(config.port).toBe(8080);
  });

  it("parses PORT from env", () => {
    process.env.PORT = "3000";
    const config = loadConfig();
    expect(config.port).toBe(3000);
  });

  it("defaults optional fields", () => {
    const config = loadConfig();
    expect(config.webUiDir).toBe("");
    expect(config.gatewayUrl).toBe("");
    expect(config.cookieDomain).toBe("");
    expect(config.oidcClientSecret).toBe("");
    expect(config.oidcCliClientId).toBe("");
    expect(config.tlsInsecureSkipVerify).toBe(false);
    expect(config.secureCookies).toBe(true);
  });

  it("sets secureCookies false when COOKIE_SECURE=false", () => {
    process.env.COOKIE_SECURE = "false";
    const config = loadConfig();
    expect(config.secureCookies).toBe(false);
  });

  it("sets tlsInsecureSkipVerify when enabled", () => {
    process.env.TLS_INSECURE_SKIP_VERIFY = "true";
    const config = loadConfig();
    expect(config.tlsInsecureSkipVerify).toBe(true);
  });

  it("throws when required env var missing", () => {
    delete process.env.OIDC_ISSUER;
    expect(() => loadConfig()).toThrow("OIDC_ISSUER is required");
  });

  it("throws when COOKIE_SECRET is wrong length", () => {
    process.env.COOKIE_SECRET = "abcd";
    expect(() => loadConfig()).toThrow("COOKIE_SECRET must be a 64-char hex string");
  });
});
