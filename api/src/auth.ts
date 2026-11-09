import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AccessWatch } from "./authz.js";
import type { Config } from "./config.js";
import type { OIDCProvider } from "./oidc.js";
import { verifyToken } from "./oidc.js";
import {
  isCodeChallenge,
  randomToken,
  signAccessToken,
  verifyAccessToken,
  verifyCodeVerifier,
  type AccessClaims,
} from "./token.js";
import type { TokenStore } from "./token-store.js";
import { validateReturnTo, APP_REDIRECT_URI } from "./origins.js";
import { requireClientProtocol } from "./protocol.js";

export type AuthEnv = {
  Variables: {
    userId: string;
    claims: AccessClaims;
    token: string;
    /** Set by requireAccess, for routes that keep a stream open. */
    watchAccess?: AccessWatch;
  };
};

export function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  if ((c.req.header("upgrade") ?? "").toLowerCase() === "websocket") {
    return c.req.query("access_token") ?? null;
  }
  return null;
}

export function authMiddleware(config: Pick<Config, "tokenSecret">) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = bearerToken(c);
    const claims = token ? verifyAccessToken(token, config.tokenSecret) : null;
    if (!token || !claims) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", claims.uid);
    c.set("claims", claims);
    c.set("token", token);
    await next();
  });
}

interface AuthDeps {
  config: Config;
  provider: OIDCProvider;
  tokens: TokenStore;
  isAllowedOrigin: (origin: string) => boolean;
}

function tokenResponse(c: Context, config: Config, claims: AccessClaims, refreshToken: string) {
  return c.json({
    access_token: signAccessToken(claims, config.tokenSecret, config.accessTokenTtl),
    refresh_token: refreshToken,
    expires_in: config.accessTokenTtl,
  });
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function stringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value ? value : null;
}

async function readField(c: Context, field: string): Promise<string | null> {
  return stringField(await readBody(c), field);
}

// The user of a verified ID token; null when it lacks the configured user claim.
// Sessions are owned by an IdP-assigned ID; the email is only for display and logs.
function userFromIdToken(idClaims: Record<string, unknown>, userClaim: string): AccessClaims | null {
  const uid = idClaims[userClaim];
  if (typeof uid !== "string" || !uid) return null;
  return {
    uid,
    email: typeof idClaims.email === "string" ? idClaims.email : "",
    name: typeof idClaims.name === "string" ? idClaims.name : "",
  };
}

export function authRoutes({ config, provider, tokens, isAllowedOrigin }: AuthDeps) {
  const app = new Hono();
  const authCookie = { path: "/auth", maxAge: 300, httpOnly: true, sameSite: "Lax" as const, secure: config.secureCookies };

  // Lets the CLI log in with only the server URL configured. The authorization endpoint
  // override is browser-facing, so the CLI can use it too; the token endpoint override
  // may be in-cluster and is not published.
  app.get("/auth/cli-config", (c) =>
    c.json({
      issuer: provider.discovery.issuer,
      ...(config.oidcCliClientId ? { clientId: config.oidcCliClientId } : {}),
      ...(config.oidcAuthorizationEndpoint ? { authorizationEndpoint: config.oidcAuthorizationEndpoint } : {}),
    }),
  );

  // The mobile apps sign in as a public client with PKCE in the system browser view, which loads
  // only the IdP; the app then hands the code to /auth/app-token. Off without OIDC_APP_CLIENT_ID.
  app.get("/auth/app-config", (c) => {
    if (!config.oidcAppClientId) return c.json({ error: "not_found" }, 404);
    return c.json({
      authorizationEndpoint: provider.discovery.authorization_endpoint,
      clientId: config.oidcAppClientId,
      redirectUri: APP_REDIRECT_URI,
      ...(config.appLoginPrompt ? { prompt: config.appLoginPrompt } : {}),
    });
  });

  app.post("/auth/app-token", requireClientProtocol(), async (c) => {
    if (!config.oidcAppClientId) return c.json({ error: "not_found" }, 404);
    const body = await readBody(c);
    const code = stringField(body, "code");
    const verifier = stringField(body, "code_verifier");
    const nonce = stringField(body, "nonce");
    // The app shows the reason, so a failed sign-in can be diagnosed on the device.
    const rejected = (reason: string) => {
      console.error(`app sign-in: ${reason}`);
      return c.json({ error: "invalid_grant", error_description: reason }, 400);
    };
    if (!code || !verifier || !nonce) return rejected("missing code, code_verifier or nonce");

    let tokenRes: Response;
    try {
      tokenRes = await fetch(provider.discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.oidcAppClientId,
          code,
          code_verifier: verifier,
          redirect_uri: APP_REDIRECT_URI,
        }),
      });
    } catch (err) {
      console.error("app sign-in: token endpoint unreachable:", err);
      return c.json({ error: "unavailable", error_description: "the server cannot reach the IdP token endpoint" }, 503);
    }
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!tokenRes.ok) {
      const idpError = [tokenBody.error, tokenBody.error_description].filter((v) => typeof v === "string" && v).join(": ");
      return rejected(`IdP token endpoint answered ${tokenRes.status}${idpError ? ` (${idpError})` : ""}`);
    }
    const idToken = tokenBody.id_token;
    if (typeof idToken !== "string" || !idToken) return rejected("IdP sent no ID token");
    let idClaims: Record<string, unknown>;
    try {
      idClaims = (await verifyToken(provider, idToken, config.oidcAppClientId)) as typeof idClaims;
    } catch (err) {
      return rejected(`ID token not valid: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (idClaims.nonce !== nonce) return rejected("ID token nonce does not match");
    const claims = userFromIdToken(idClaims, config.oidcUserClaim);
    if (!claims) return rejected(`ID token has no ${config.oidcUserClaim} claim`);
    try {
      const session = await tokens.createChain(claims);
      console.log(`login: user=${claims.uid} email=${claims.email} name=${claims.name} client=app`);
      return tokenResponse(c, config, session.claims, session.refreshToken);
    } catch (err) {
      console.error("app sign-in: token store failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
  });

  app.get("/auth/start", (c) => {
    const returnTo = validateReturnTo(c.req.query("return_to"), isAllowedOrigin);
    if (!returnTo) return c.json({ error: "invalid return_to" }, 400);
    const challenge = c.req.query("code_challenge");
    if (!isCodeChallenge(challenge)) return c.json({ error: "invalid_request" }, 400);

    const state = randomToken(16);
    setCookie(c, "orc_state", state, authCookie);
    setCookie(c, "orc_return", returnTo, authCookie);
    setCookie(c, "orc_challenge", challenge, authCookie);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.oidcClientId,
      redirect_uri: config.oidcRedirectUri,
      scope: "openid email profile",
      state,
    });
    return c.redirect(`${provider.discovery.authorization_endpoint}?${params}`);
  });

  app.get("/auth/callback", async (c) => {
    const stateCookie = getCookie(c, "orc_state");
    const stateParam = c.req.query("state");
    if (!stateCookie || stateCookie !== stateParam) {
      return c.text("invalid state", 400);
    }
    const returnTo = validateReturnTo(getCookie(c, "orc_return"), isAllowedOrigin) ?? "/";
    const challenge = getCookie(c, "orc_challenge");
    if (!isCodeChallenge(challenge)) {
      return c.text("missing code challenge", 400);
    }

    const code = c.req.query("code");
    if (!code) {
      return c.text("missing code", 400);
    }

    const tokenParams: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: config.oidcClientId,
      code,
      redirect_uri: config.oidcRedirectUri,
    };
    if (config.oidcClientSecret) {
      tokenParams.client_secret = config.oidcClientSecret;
    }

    const tokenRes = await fetch(provider.discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenParams),
    });
    if (!tokenRes.ok) {
      console.error(`OIDC token exchange failed: ${tokenRes.status}`);
      return c.text("authentication failed", 401);
    }

    const tokenData = (await tokenRes.json()) as { id_token?: string };
    if (!tokenData.id_token) {
      return c.text("no id_token in response", 401);
    }

    let idClaims: Record<string, unknown>;
    try {
      idClaims = (await verifyToken(provider, tokenData.id_token, config.oidcClientId)) as typeof idClaims;
    } catch (err) {
      console.error("ID token verification failed:", err);
      return c.text("invalid id_token", 401);
    }

    const claims = userFromIdToken(idClaims, config.oidcUserClaim);
    if (!claims) {
      console.error(`ID token has no ${config.oidcUserClaim} claim`);
      return c.text("invalid id_token", 401);
    }

    let loginCode: string;
    try {
      loginCode = await tokens.createCode(claims, challenge);
    } catch (err) {
      console.error("login code store failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }

    deleteCookie(c, "orc_state", { path: "/auth" });
    deleteCookie(c, "orc_return", { path: "/auth" });
    deleteCookie(c, "orc_challenge", { path: "/auth" });
    console.log(`login: user=${claims.uid} email=${claims.email} name=${claims.name}`);
    return c.redirect(`${returnTo}#code=${encodeURIComponent(loginCode)}`);
  });

  app.post("/auth/token", requireClientProtocol(), async (c) => {
    const body = await readBody(c);
    const code = stringField(body, "code");
    if (!code) return c.json({ error: "invalid_grant" }, 400);
    try {
      // Consumed before the verifier check, so a wrong verifier burns the code.
      const record = await tokens.consumeCode(code);
      if (!record || !verifyCodeVerifier(stringField(body, "code_verifier"), record.challenge)) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      const session = await tokens.createChain(record.claims);
      return tokenResponse(c, config, session.claims, session.refreshToken);
    } catch (err) {
      console.error("token exchange failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
  });

  app.post("/auth/refresh", requireClientProtocol(), async (c) => {
    const refreshToken = await readField(c, "refresh_token");
    if (!refreshToken) return c.json({ error: "invalid_grant" }, 401);
    try {
      const result = await tokens.rotate(refreshToken);
      if (!result.ok) return c.json({ error: "invalid_grant" }, 401);
      return tokenResponse(c, config, result.claims, result.refreshToken);
    } catch (err) {
      console.error("refresh failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
  });

  app.post("/auth/logout", async (c) => {
    const refreshToken = await readField(c, "refresh_token");
    if (refreshToken) {
      try {
        await tokens.revoke(refreshToken);
      } catch (err) {
        console.error("logout revoke failed:", err);
      }
    }
    return c.body(null, 204);
  });

  return app;
}
