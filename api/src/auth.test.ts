import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware, authRoutes, type AuthEnv } from "./auth.js";
import { codeChallenge, randomToken, signAccessToken } from "./token.js";
import { TokenStore } from "./token-store.js";
import { MockRedis } from "./testing/mock-redis.js";
import { makeOriginCheck } from "./origins.js";
import { PROTOCOL_HEADER } from "./protocol.js";
import type { Config } from "./config.js";
import type { OIDCProvider } from "./oidc.js";

vi.mock("./oidc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oidc.js")>()),
  verifyToken: vi.fn(async () => ({ sub: "alice", email: "alice@example.com", name: "Alice" })),
}));

const secret = new Uint8Array(32).fill(0xab);
const claims = { uid: "alice@example.com", email: "alice@example.com", name: "Alice" };

const config: Config = {
  port: 8080,
  oidcIssuer: "https://idp.example.com",
  oidcClientId: "test",
  oidcClientSecret: "",
  oidcCliClientId: "",
  oidcRedirectUri: "https://rc.example.com/auth/callback",
  oidcIssuerOverride: "",
  oidcAuthorizationEndpoint: "",
  oidcTokenEndpoint: "",
  oidcJwksUri: "",
  tokenSecret: secret,
  accessTokenTtl: 900,
  sessionTtl: 7 * 24 * 3600,
  allowedOrigins: [],
  appLoginPrompt: "select_account",
  secureCookies: false,
  redisUrl: "redis://localhost:6379/0",
  gatewayUrl: "",
  tlsInsecureSkipVerify: false,
};

const provider = {
  discovery: {
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
    issuer: "https://idp.example.com",
  },
  jwks: (() => {}) as unknown,
} as OIDCProvider;

let tokens: TokenStore;
let app: Hono<AuthEnv>;

beforeEach(() => {
  tokens = new TokenStore(new MockRedis(), config.sessionTtl);
  app = new Hono<AuthEnv>();
  app.route(
    "/",
    authRoutes({
      config,
      provider,
      tokens,
      isAllowedOrigin: makeOriginCheck("https://rc.example.com", []),
    }),
  );
  app.get("/protected", authMiddleware(config), (c) =>
    c.json({ userId: c.get("userId"), token: c.get("token") }),
  );
});

afterEach(() => vi.restoreAllMocks());

const verifier = randomToken();
const challenge = codeChallenge(verifier);

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", [PROTOCOL_HEADER]: "1" },
    body: JSON.stringify(body),
  });

describe("authMiddleware", () => {
  it("returns 401 without a token", async () => {
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts a valid bearer token", async () => {
    const token = signAccessToken(claims, secret, 900);
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "alice@example.com", token });
  });

  it("rejects an expired token", async () => {
    const token = signAccessToken(claims, secret, 900, Date.now() - 1_000_000);
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("ignores access_token query on normal requests", async () => {
    const token = signAccessToken(claims, secret, 900);
    const res = await app.request(`/protected?access_token=${token}`);
    expect(res.status).toBe(401);
  });

  it("accepts access_token query on websocket upgrades", async () => {
    const token = signAccessToken(claims, secret, 900);
    const res = await app.request(`/protected?access_token=${token}`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(200);
  });

  it("ignores the old session cookie", async () => {
    const res = await app.request("/protected", { headers: { cookie: "orc_session=abc.def" } });
    expect(res.status).toBe(401);
  });
});

describe("/auth/start", () => {
  it("redirects to the IdP and stores state, return_to and the code challenge", async () => {
    const res = await app.request(
      `/auth/start?return_to=com.opencode.rc%3A%2Fauth%2Fdone&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/idp\.example\.com\/authorize\?/);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("orc_state=");
    expect(cookies).toContain("orc_return=com.opencode.rc%3A%2Fauth%2Fdone");
    expect(cookies).toMatch(new RegExp(`orc_challenge=${challenge}; Max-Age=300; Path=/auth; HttpOnly`));
  });

  it("requires a well-formed code_challenge", async () => {
    for (const q of ["", "&code_challenge=short", `&code_challenge=${challenge}x`]) {
      const res = await app.request(`/auth/start?return_to=%2F${q}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("rejects a return_to with a control character", async () => {
    const res = await app.request(`/auth/start?return_to=%2F%09%2Fevil.com&code_challenge=${challenge}`);
    expect(res.status).toBe(400);
  });

  it("rejects a foreign return_to", async () => {
    const res = await app.request(
      `/auth/start?return_to=https%3A%2F%2Fevil.example.com%2F&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(400);
  });

  // RFC 8252 section 8.6: the app callback scheme cannot identify the app, so the IdP
  // must make the user interact; an impersonating app cannot complete a login silently.
  it("asks the IdP to prompt the user for app logins", async () => {
    const res = await app.request(
      `/auth/start?return_to=com.opencode.rc%3A%2Fauth%2Fdone&code_challenge=${challenge}`,
    );
    expect(new URL(res.headers.get("location")!).searchParams.get("prompt")).toBe("select_account");
  });

  it("leaves web logins without a prompt", async () => {
    const res = await app.request(`/auth/start?return_to=%2Fs%2Fx%2F&code_challenge=${challenge}`);
    expect(new URL(res.headers.get("location")!).searchParams.has("prompt")).toBe(false);
  });

  it("sends no prompt when the app login prompt is disabled", async () => {
    const a = new Hono();
    a.route("/", authRoutes({
      config: { ...config, appLoginPrompt: "" },
      provider,
      tokens,
      isAllowedOrigin: makeOriginCheck("https://rc.example.com", []),
    }));
    const res = await a.request(
      `/auth/start?return_to=com.opencode.rc%3A%2Fauth%2Fdone&code_challenge=${challenge}`,
    );
    expect(new URL(res.headers.get("location")!).searchParams.has("prompt")).toBe(false);
  });

  it("rejects the old WebView return_to", async () => {
    const res = await app.request(
      `/auth/start?return_to=https%3A%2F%2Flocalhost%2F&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("/auth/callback", () => {
  const callback = (cookies: string) =>
    app.request("/auth/callback?state=st&code=idp-code", { headers: { cookie: cookies } });

  it("redirects to the mobile app callback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    const res = await callback(
      `orc_state=st; orc_return=com.opencode.rc%3A%2Fauth%2Fdone; orc_challenge=${challenge}`,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^com\.opencode\.rc:\/auth\/done#code=/);
    const code = decodeURIComponent(location.split("#code=")[1]);
    const ok = await post("/auth/token", { code, code_verifier: verifier });
    expect(ok.status).toBe(200);
  });

  it("redirects to an absolute web origin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    const res = await callback(
      `orc_state=st; orc_return=https%3A%2F%2Frc.example.com%2Fs%2Fx%2F; orc_challenge=${challenge}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/rc\.example\.com\/s\/x\/#code=/);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("rejects a callback without a code challenge cookie", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await callback("orc_state=st; orc_return=%2F");
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("/auth/token", () => {
  it("exchanges a code for tokens once", async () => {
    const code = await tokens.createCode(claims, challenge);
    const res = await post("/auth/token", { code, code_verifier: verifier });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expires_in).toBe(900);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");

    const again = await post("/auth/token", { code, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_grant" });
  });

  it("rejects a missing code", async () => {
    const res = await post("/auth/token", {});
    expect(res.status).toBe(400);
  });

  it("rejects a missing verifier and burns the code", async () => {
    const code = await tokens.createCode(claims, challenge);
    const res = await post("/auth/token", { code });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    const retry = await post("/auth/token", { code, code_verifier: verifier });
    expect(retry.status).toBe(400);
  });

  it("rejects a wrong verifier and burns the code", async () => {
    const code = await tokens.createCode(claims, challenge);
    const res = await post("/auth/token", { code, code_verifier: randomToken() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    const retry = await post("/auth/token", { code, code_verifier: verifier });
    expect(retry.status).toBe(400);
  });

  it("rejects a client without the protocol header", async () => {
    const res = await app.request("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x", code_verifier: "y" }),
    });
    expect(res.status).toBe(426);
  });
});

describe("/auth/refresh and /auth/logout", () => {
  async function login() {
    const code = await tokens.createCode(claims, challenge);
    return (await (await post("/auth/token", { code, code_verifier: verifier })).json()) as {
      access_token: string;
      refresh_token: string;
    };
  }

  it("rotates the refresh token and issues a working access token", async () => {
    const first = await login();
    const res = await post("/auth/refresh", { refresh_token: first.refresh_token });
    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.refresh_token).not.toBe(first.refresh_token);
    const me = await app.request("/protected", {
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(me.status).toBe(200);
  });

  it("returns 401 invalid_grant for an unknown token", async () => {
    const res = await post("/auth/refresh", { refresh_token: "nope" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  it("logout revokes the chain", async () => {
    const first = await login();
    const out = await post("/auth/logout", { refresh_token: first.refresh_token });
    expect(out.status).toBe(204);
    const res = await post("/auth/refresh", { refresh_token: first.refresh_token });
    expect(res.status).toBe(401);
  });

  it("rejects refresh without the protocol header but always allows logout", async () => {
    const plain = (path: string) => app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "nope" }),
    });
    expect((await plain("/auth/refresh")).status).toBe(426);
    expect((await plain("/auth/logout")).status).not.toBe(426);
  });

  it("returns 503 when Redis fails", async () => {
    const broken = new TokenStore(
      {
        get: async () => { throw new Error("down"); },
        getdel: async () => { throw new Error("down"); },
        set: async () => { throw new Error("down"); },
        del: async () => { throw new Error("down"); },
        ttl: async () => { throw new Error("down"); },
      },
      config.sessionTtl,
    );
    const a = new Hono();
    a.route("/", authRoutes({ config, provider, tokens: broken, isAllowedOrigin: () => false }));
    const res = await a.request("/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", [PROTOCOL_HEADER]: "1" },
      body: JSON.stringify({ refresh_token: "x" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
