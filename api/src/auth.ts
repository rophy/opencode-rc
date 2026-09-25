import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
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
import { validateReturnTo, APP_CALLBACK } from "./origins.js";

export type AuthEnv = {
  Variables: {
    userId: string;
    claims: AccessClaims;
    token: string;
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

function scriptRedirect(c: Context, target: string) {
  // "<" is escaped so the value cannot close the script element.
  const literal = JSON.stringify(target).replace(/</g, "\\u003c");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'");
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Signing in</title><script>location.replace(${literal})</script>`,
  );
}

export function authRoutes({ config, provider, tokens, isAllowedOrigin }: AuthDeps) {
  const app = new Hono();
  const authCookie = { path: "/auth", maxAge: 300, httpOnly: true, sameSite: "Lax" as const, secure: config.secureCookies };

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

    let idClaims: { email?: string; sub?: string; name?: string };
    try {
      idClaims = (await verifyToken(provider, tokenData.id_token, config.oidcClientId)) as typeof idClaims;
    } catch (err) {
      console.error("ID token verification failed:", err);
      return c.text("invalid id_token", 401);
    }

    const claims: AccessClaims = {
      uid: idClaims.email || idClaims.sub || "",
      email: idClaims.email ?? "",
      name: idClaims.name ?? "",
    };

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
    console.log(`login: user=${claims.uid} name=${claims.name}`);
    const target = `${returnTo}#code=${encodeURIComponent(loginCode)}`;
    // Absolute web origins (the separately hosted web UI) get the script-navigation
    // page, as before; paths and the app callback use a normal redirect.
    return returnTo.startsWith("/") || returnTo === APP_CALLBACK
      ? c.redirect(target)
      : scriptRedirect(c, target);
  });

  app.post("/auth/token", async (c) => {
    const body = await readBody(c);
    const code = stringField(body, "code");
    if (!code) return c.json({ error: "invalid_grant" }, 400);
    try {
      // Consumed before the verifier check, so a wrong verifier burns the code.
      const record = await tokens.consumeCode(code);
      if (!record || !verifyCodeVerifier(stringField(body, "code_verifier"), record.challenge)) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      const { claims } = record;
      const refreshToken = await tokens.createChain(claims);
      return tokenResponse(c, config, claims, refreshToken);
    } catch (err) {
      console.error("token exchange failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
  });

  app.post("/auth/refresh", async (c) => {
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
