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

export function authMiddleware(config: Config) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const cookieHeader = c.req.raw.headers.get("cookie") ?? "";
    const match = cookieHeader.match(/orc_session=([^;]+)/);
    if (!match) return c.redirect("/auth/login");

    const data = decodeCookie(match[1], config.cookieSecret);
    if (!data) return c.redirect("/auth/login");
    if (Date.now() / 1000 > data.exp) return c.redirect("/auth/login");

    c.set("userId", data.uid);
    c.set("session", data);
    await next();
  });
}

export function authRoutes(config: Config, provider: OIDCProvider) {
  const app = new Hono();

  app.get("/auth/login", (c) => {
    return c.html(loginPageHTML);
  });

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

const loginPageHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode-rc</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f5f5f5;
    color: #1a1a1a;
  }
  .card {
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    padding: 2.5rem;
    text-align: center;
    max-width: 360px;
    width: 100%;
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
  p { font-size: 0.875rem; color: #666; margin-bottom: 1.5rem; }
  .btn {
    display: inline-block;
    background: #1a1a1a;
    color: #fff;
    padding: 0.625rem 1.5rem;
    border-radius: 6px;
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 500;
    transition: background 0.15s;
  }
  .btn:hover { background: #333; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #e5e5e5; }
    .card { background: #1a1a1a; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
    p { color: #999; }
    .btn { background: #e5e5e5; color: #1a1a1a; }
    .btn:hover { background: #ccc; }
  }
</style>
</head>
<body>
<div class="card">
  <h1>opencode-rc</h1>
  <p>Remote control for OpenCode</p>
  <a class="btn" href="/auth/start">Sign in with OIDC</a>
</div>
</body>
</html>`;
