import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Config } from "./config.js";
import type { OIDCProvider } from "./oidc.js";
import { verifyToken } from "./oidc.js";
import {
  encodeCookie,
  decodeCookie,
  generateState,
  type SessionData,
} from "./cookie.js";

export type AuthEnv = {
  Variables: {
    userId: string;
    session: SessionData;
  };
};

function authFailed(c: any): Response {
  const accept = c.req.raw.headers.get("accept") ?? "";
  if (accept.includes("application/json") || c.req.path.startsWith("/api/") || c.req.path.startsWith("/gateway/")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.redirect("/");
}

export function authMiddleware(config: Config) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const cookieHeader = c.req.raw.headers.get("cookie") ?? "";
    const match = cookieHeader.match(/orc_session=([^;]+)/);
    if (!match) return authFailed(c);

    const data = decodeCookie(match[1], config.cookieSecret);
    if (!data) return authFailed(c);
    if (Date.now() / 1000 > data.exp) return authFailed(c);

    c.set("userId", data.uid);
    c.set("session", data);
    await next();
  });
}

export function authRoutes(config: Config, provider: OIDCProvider) {
  const app = new Hono();

  app.get("/auth/start", (c) => {
    const state = generateState();
    setCookie(c, "orc_state", state, {
      path: "/auth",
      maxAge: 300,
      httpOnly: true,
      sameSite: "Lax",
      secure: config.secureCookies,
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.oidcClientId,
      redirect_uri: config.oidcRedirectUri,
      scope: "openid email profile",
      state,
    });

    return c.redirect(
      `${provider.discovery.authorization_endpoint}?${params}`
    );
  });

  app.get("/auth/callback", async (c) => {
    const stateCookie = getCookie(c, "orc_state");
    const stateParam = c.req.query("state");
    if (!stateCookie || stateCookie !== stateParam) {
      return c.text("invalid state", 400);
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

    const tokenData = (await tokenRes.json()) as {
      id_token?: string;
    };
    if (!tokenData.id_token) {
      return c.text("no id_token in response", 401);
    }

    let claims: { email?: string; sub?: string; name?: string };
    try {
      const payload = await verifyToken(
        provider,
        tokenData.id_token,
        config.oidcClientId
      );
      claims = payload as typeof claims;
    } catch (err) {
      console.error("ID token verification failed:", err);
      return c.text("invalid id_token", 401);
    }

    const userId = claims.email || claims.sub || "";
    const sessionData: SessionData = {
      uid: userId,
      email: claims.email ?? "",
      name: claims.name ?? "",
      exp: Math.floor(Date.now() / 1000) + 86400,
    };

    const encoded = encodeCookie(sessionData, config.cookieSecret);
    setCookie(c, "orc_session", encoded, {
      path: "/",
      maxAge: 86400,
      httpOnly: true,
      sameSite: "Lax",
      secure: config.secureCookies,
      domain: config.cookieDomain || undefined,
    });

    deleteCookie(c, "orc_state", { path: "/auth" });

    console.log(`login: user=${userId} name=${claims.name ?? ""}`);
    return c.redirect("/");
  });

  app.get("/auth/logout", (c) => {
    deleteCookie(c, "orc_session", {
      path: "/",
      domain: config.cookieDomain || undefined,
    });
    return c.redirect("/");
  });

  return app;
}

