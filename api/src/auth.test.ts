import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware, authRoutes, type AuthEnv } from "./auth.js";
import { verifyToken } from "./oidc.js";
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
  oidcAppClientId: "",
  oidcUserClaim: "sub",
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
  authzWebhookUrl: "",
  authzWebhookToken: "",
  authzTimeout: 5,
  authzAllowedTtl: 60,
  authzDeniedTtl: 10,
  adminToken: "",
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

describe("GET /auth/cli-config", () => {
  it("returns the issuer and CLI client ID", async () => {
    app = new Hono<AuthEnv>();
    app.route("/", authRoutes({
      config: { ...config, oidcCliClientId: "opencode-rc-cli" },
      provider,
      tokens,
      isAllowedOrigin: () => false,
    }));
    const res = await app.request("/auth/cli-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: "https://idp.example.com", clientId: "opencode-rc-cli" });
  });

  it("omits clientId when no CLI client is configured", async () => {
    const res = await app.request("/auth/cli-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: "https://idp.example.com" });
  });

  it("returns the overridden authorization endpoint", async () => {
    app = new Hono<AuthEnv>();
    app.route("/", authRoutes({
      config: { ...config, oidcAuthorizationEndpoint: "https://login.example.com/authorize" },
      provider,
      tokens,
      isAllowedOrigin: () => false,
    }));
    const res = await app.request("/auth/cli-config");
    expect(await res.json()).toEqual({
      issuer: "https://idp.example.com",
      authorizationEndpoint: "https://login.example.com/authorize",
    });
  });
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
      `/auth/start?return_to=%2Fs%2Fx%2F&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/idp\.example\.com\/authorize\?/);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("orc_state=");
    expect(cookies).toContain("orc_return=%2Fs%2Fx%2F");
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

  it("rejects the old app callback as return_to", async () => {
    const res = await app.request(
      `/auth/start?return_to=${encodeURIComponent("com.opencode.rc:/auth/done")}&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(400);
  });

  it("never sends a prompt", async () => {
    const res = await app.request(`/auth/start?return_to=%2F&code_challenge=${challenge}`);
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

  it("redirects to an absolute web origin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    const res = await callback(
      `orc_state=st; orc_return=https%3A%2F%2Frc.example.com%2Fs%2Fx%2F; orc_challenge=${challenge}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/rc\.example\.com\/s\/x\/#code=/);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  const loggedInUser = async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    const res = await callback(`orc_state=st; orc_return=%2F; orc_challenge=${challenge}`);
    if (res.status !== 302) return { status: res.status };
    const code = decodeURIComponent(res.headers.get("location")!.split("#code=")[1]);
    const record = await tokens.consumeCode(code);
    return { status: res.status, claims: record?.claims };
  };

  it("keys the user by the sub claim and keeps the email", async () => {
    const { claims: got } = await loggedInUser();
    expect(got).toEqual({ uid: "alice", email: "alice@example.com", name: "Alice" });
  });

  it("keys the user by the configured claim", async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: "pairwise", oid: "stable-oid", email: "alice@example.com" });
    app = new Hono<AuthEnv>();
    app.route("/", authRoutes({
      config: { ...config, oidcUserClaim: "oid" },
      provider,
      tokens,
      isAllowedOrigin: () => false,
    }));
    const { claims: got } = await loggedInUser();
    expect(got?.uid).toBe("stable-oid");
  });

  it("rejects an ID token without the user claim", async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ email: "alice@example.com" });
    const { status } = await loggedInUser();
    expect(status).toBe(401);
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

describe("app sign-in", () => {
  const appConfig: Config = { ...config, oidcAppClientId: "opencode-rc-app" };
  const useConfig = (cfg: Config) => {
    app = new Hono<AuthEnv>();
    app.route("/", authRoutes({ config: cfg, provider, tokens, isAllowedOrigin: () => false }));
    app.get("/protected", authMiddleware(cfg), (c) => c.json({ userId: c.get("userId") }));
  };
  const idClaims = { sub: "alice", email: "alice@example.com", name: "Alice", nonce: "n1" };

  it("GET /auth/app-config returns the public client", async () => {
    useConfig(appConfig);
    const res = await app.request("/auth/app-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authorizationEndpoint: "https://idp.example.com/authorize",
      clientId: "opencode-rc-app",
      redirectUri: "com.opencode.rc:/auth/callback",
      prompt: "select_account",
    });
  });

  it("GET /auth/app-config omits prompt when it is disabled", async () => {
    useConfig({ ...appConfig, appLoginPrompt: "" });
    expect(await (await app.request("/auth/app-config")).json()).not.toHaveProperty("prompt");
  });

  it("answers 404 without an app client", async () => {
    useConfig(config);
    expect((await app.request("/auth/app-config")).status).toBe(404);
    expect((await post("/auth/app-token", { code: "c", code_verifier: "v", nonce: "n1" })).status).toBe(404);
  });

  it("exchanges the code as a public client and issues tokens", async () => {
    useConfig(appConfig);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockResolvedValueOnce(idClaims);

    const res = await post("/auth/app-token", { code: "idp-code", code_verifier: verifier, nonce: "n1" });
    expect(res.status).toBe(200);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://idp.example.com/token");
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      client_id: "opencode-rc-app",
      code: "idp-code",
      code_verifier: verifier,
      redirect_uri: "com.opencode.rc:/auth/callback",
    });
    expect(verifyToken).toHaveBeenCalledWith(provider, "id", "opencode-rc-app");

    const body = await res.json();
    const me = await app.request("/protected", { headers: { authorization: `Bearer ${body.access_token}` } });
    expect(await me.json()).toEqual({ userId: "alice" });
    expect(body.refresh_token).toBeTruthy();
  });

  it("rejects a nonce mismatch", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockResolvedValueOnce({ ...idClaims, nonce: "other" });
    const res = await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  it("rejects a failed code exchange", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(400);
  });

  it("rejects an ID token that fails verification", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error("bad signature"));
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(400);
  });

  it("rejects an ID token without the user claim", async () => {
    useConfig({ ...appConfig, oidcUserClaim: "oid" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: "id" }));
    vi.mocked(verifyToken).mockResolvedValueOnce(idClaims);
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(400);
  });

  it("rejects missing fields without calling the IdP", async () => {
    useConfig(appConfig);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const body of [{ code_verifier: verifier, nonce: "n1" }, { code: "c", nonce: "n1" }, { code: "c", code_verifier: verifier }])
      expect((await post("/auth/app-token", body)).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 503 when the IdP cannot be reached", async () => {
    useConfig(appConfig);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    expect((await post("/auth/app-token", { code: "c", code_verifier: verifier, nonce: "n1" })).status).toBe(503);
  });

  it("requires the protocol header", async () => {
    useConfig(appConfig);
    const res = await app.request("/auth/app-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "c", code_verifier: verifier, nonce: "n1" }),
    });
    expect(res.status).not.toBe(200);
  });
});
