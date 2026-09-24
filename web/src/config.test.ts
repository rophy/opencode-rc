import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, parseDuration } from "./config.js";

const validEnv: Record<string, string> = {
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_CLIENT_ID: "my-client",
  OIDC_REDIRECT_URI: "https://app.example.com/auth/callback",
  TOKEN_SECRET: "ab".repeat(32),
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
  delete process.env.COOKIE_SECURE;
  delete process.env.TLS_INSECURE_SKIP_VERIFY;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_CLI_CLIENT_ID;
  delete process.env.OIDC_ISSUER_OVERRIDE;
  delete process.env.OIDC_AUTHORIZATION_ENDPOINT;
  delete process.env.OIDC_TOKEN_ENDPOINT;
  delete process.env.OIDC_JWKS_URI;
  delete process.env.COOKIE_SECRET;
  delete process.env.ACCESS_TOKEN_TTL;
  delete process.env.SESSION_TTL;
  delete process.env.ALLOWED_ORIGINS;
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
    expect(config.tokenSecret).toBeInstanceOf(Uint8Array);
    expect(config.tokenSecret.length).toBe(32);
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
    expect(config.oidcClientSecret).toBe("");
    expect(config.oidcCliClientId).toBe("");
    expect(config.oidcIssuerOverride).toBe("");
    expect(config.oidcAuthorizationEndpoint).toBe("");
    expect(config.oidcTokenEndpoint).toBe("");
    expect(config.oidcJwksUri).toBe("");
    expect(config.tlsInsecureSkipVerify).toBe(false);
    expect(config.secureCookies).toBe(true);
    expect(config.accessTokenTtl).toBe(900);
    expect(config.sessionTtl).toBe(7 * 24 * 3600);
    expect(config.allowedOrigins).toEqual([]);
  });

  it("reads OIDC endpoint overrides from env", () => {
    process.env.OIDC_ISSUER_OVERRIDE = "https://external.idp.example.com";
    process.env.OIDC_AUTHORIZATION_ENDPOINT = "https://external.idp.example.com/authorize";
    process.env.OIDC_TOKEN_ENDPOINT = "https://internal.idp.example.com/token";
    process.env.OIDC_JWKS_URI = "https://internal.idp.example.com/jwks";
    const config = loadConfig();
    expect(config.oidcIssuerOverride).toBe("https://external.idp.example.com");
    expect(config.oidcAuthorizationEndpoint).toBe("https://external.idp.example.com/authorize");
    expect(config.oidcTokenEndpoint).toBe("https://internal.idp.example.com/token");
    expect(config.oidcJwksUri).toBe("https://internal.idp.example.com/jwks");
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

  it("throws when TOKEN_SECRET is wrong length", () => {
    process.env.TOKEN_SECRET = "abcd";
    expect(() => loadConfig()).toThrow("TOKEN_SECRET must be a 64-char hex string");
  });
});

describe("token settings", () => {
  it("falls back to COOKIE_SECRET", () => {
    delete process.env.TOKEN_SECRET;
    process.env.COOKIE_SECRET = "cd".repeat(32);
    const config = loadConfig();
    expect(Buffer.from(config.tokenSecret).toString("hex")).toBe("cd".repeat(32));
  });

  it("parses TTLs and allowed origins", () => {
    process.env.ACCESS_TOKEN_TTL = "5m";
    process.env.SESSION_TTL = "2d";
    process.env.ALLOWED_ORIGINS = "https://a.example.com, https://b.example.com";
    const config = loadConfig();
    expect(config.accessTokenTtl).toBe(300);
    expect(config.sessionTtl).toBe(172800);
    expect(config.allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });
});

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("1h")).toBe(3600);
    expect(parseDuration("7d")).toBe(604800);
  });

  it("rejects invalid input", () => {
    expect(() => parseDuration("15")).toThrow();
    expect(() => parseDuration("0m")).toThrow();
    expect(() => parseDuration("1w")).toThrow();
  });
});
