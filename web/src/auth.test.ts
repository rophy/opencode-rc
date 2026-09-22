import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, type AuthEnv } from "./auth.js";
import { encodeCookie, type SessionData } from "./cookie.js";

const secret = new Uint8Array(32);
secret.fill(0xab);

const config = {
  port: 8080,
  oidcIssuer: "https://idp.example.com",
  oidcClientId: "test",
  oidcClientSecret: "",
  oidcCliClientId: "",
  oidcRedirectUri: "https://app.example.com/auth/callback",
  oidcIssuerOverride: "",
  oidcAuthorizationEndpoint: "",
  oidcTokenEndpoint: "",
  oidcJwksUri: "",
  cookieSecret: secret,
  cookieDomain: "",
  secureCookies: false,
  redisUrl: "redis://localhost:6379/0",
  webUiDir: "",
  gatewayUrl: "",
  tlsInsecureSkipVerify: false,
};

function makeApp() {
  const app = new Hono<AuthEnv>();
  const auth = authMiddleware(config);
  app.get("/protected", auth, (c) => {
    return c.json({ userId: c.get("userId"), session: c.get("session") });
  });
  return app;
}

function makeCookie(overrides: Partial<SessionData> = {}): string {
  const data: SessionData = {
    uid: "alice@example.com",
    email: "alice@example.com",
    name: "Alice",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  return encodeCookie(data, secret);
}

describe("authMiddleware", () => {
  it("redirects to login when no cookie", async () => {
    const app = makeApp();
    const res = await app.request("/protected");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("redirects when cookie has invalid signature", async () => {
    const app = makeApp();
    const res = await app.request("/protected", {
      headers: { cookie: "orc_session=garbage.value" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("redirects when cookie is expired", async () => {
    const app = makeApp();
    const expired = makeCookie({ exp: Math.floor(Date.now() / 1000) - 100 });
    const res = await app.request("/protected", {
      headers: { cookie: `orc_session=${expired}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("passes through with valid cookie", async () => {
    const app = makeApp();
    const cookie = makeCookie();
    const res = await app.request("/protected", {
      headers: { cookie: `orc_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("alice@example.com");
    expect(body.session.email).toBe("alice@example.com");
    expect(body.session.name).toBe("Alice");
  });

  it("sets userId and session on context", async () => {
    const app = makeApp();
    const cookie = makeCookie({ uid: "bob@example.com", email: "bob@example.com", name: "Bob" });
    const res = await app.request("/protected", {
      headers: { cookie: `orc_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("bob@example.com");
    expect(body.session.name).toBe("Bob");
  });
});
