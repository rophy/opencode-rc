import { describe, it, expect, beforeAll } from "vitest";

const GATEWAY_URL = "http://gateway:8080";
const TUNNELER_URL = "http://tunneler:9090";
const OIDC_URL = "http://oidc-mock:8080";
// Note: this intentionally does NOT read process.env.OIDC_CLIENT_ID /
// OIDC_CLIENT_SECRET — the dev-machine container (where these tests run)
// sets those to the CLI's own client ("opencode-rc-cli") for its PKCE
// login flow. Reusing them here would make the simulated browser login
// impersonate the wrong OAuth client and fail token exchange.
const OIDC_CLIENT_ID = process.env.GATEWAY_OIDC_CLIENT_ID ?? "opencode-rc";
const OIDC_CLIENT_SECRET =
  process.env.GATEWAY_OIDC_CLIENT_SECRET ?? "opencode-rc-secret";
const SESSION_ID = process.env.OPENCODE_RC_SESSION_ID ?? "alice-dev";

async function waitFor(
  name: string,
  url: string,
  maxSeconds = 60
): Promise<void> {
  for (let i = 1; i <= maxSeconds; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} not ready after ${maxSeconds}s`);
}

// Simple cookie jar: stores Set-Cookie headers, sends them back
class CookieJar {
  private cookies: Map<string, string> = new Map();

  capture(response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name && value) this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    const cookie = this.header();
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
    });
    this.capture(res);
    return res;
  }
}

describe("opencode-rc e2e", () => {
  const jar = new CookieJar();

  beforeAll(async () => {
    await waitFor("oidc-mock", `${OIDC_URL}/.well-known/openid-configuration`, 30);
    await waitFor("gateway", `${GATEWAY_URL}/healthz`, 30);
    await waitFor("tunneler", `${TUNNELER_URL}/healthz`, 30);
  });

  it("gateway /healthz returns ok", async () => {
    const res = await fetch(`${GATEWAY_URL}/healthz`);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("tunneler /healthz returns ok", async () => {
    const res = await fetch(`${TUNNELER_URL}/healthz`);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("gateway /auth/login shows login page", async () => {
    const res = await fetch(`${GATEWAY_URL}/auth/login`);
    const text = await res.text();
    expect(text).toContain("Sign in with OIDC");
  });

  it("OIDC login flow sets session cookie", async () => {
    // Step 1: Start auth flow — get redirect to OIDC
    const startRes = await jar.fetch(`${GATEWAY_URL}/auth/start`);
    expect(startRes.status).toBe(302);
    const redirectUrl = startRes.headers.get("location")!;
    expect(redirectUrl).toBeTruthy();

    // Extract state and redirect_uri from the OIDC redirect
    const url = new URL(redirectUrl);
    const state = url.searchParams.get("state");
    const redirectUri = url.searchParams.get("redirect_uri");
    expect(state).toBeTruthy();
    expect(redirectUri).toBeTruthy();

    // Step 2: Select user1 (Alice) on oidc-mock
    const callbackRes = await fetch(`${OIDC_URL}/authorize/callback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        sub: "user1",
        client_id: OIDC_CLIENT_ID,
        redirect_uri: redirectUri!,
        state: state!,
        nonce: "",
        scope: "openid email profile",
        code_challenge: "",
        code_challenge_method: "",
      }),
      redirect: "manual",
    });
    expect(callbackRes.status).toBe(302);
    const callbackUrl = callbackRes.headers.get("location")!;
    expect(callbackUrl).toBeTruthy();

    // Step 3: Complete the callback — gateway sets session cookie
    const completeRes = await jar.fetch(callbackUrl);
    expect(completeRes.status).toBe(302);
  });

  it("dashboard accessible with session cookie", async () => {
    const res = await jar.fetch(`${GATEWAY_URL}/`);
    expect(res.status).toBe(200);
  });

  it("rc-client tunnel connected", async () => {
    let sessions: any[] = [];
    for (let i = 0; i < 60; i++) {
      try {
        const res = await jar.fetch(`${GATEWAY_URL}/gateway/sessions`);
        sessions = await res.json();
        if (sessions.length >= 1) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("session visible in dashboard", async () => {
    const res = await jar.fetch(`${GATEWAY_URL}/gateway/sessions`);
    const sessions = await res.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("expected session found by ID", async () => {
    const res = await jar.fetch(`${GATEWAY_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const found = sessions.some((s: any) => s.id === SESSION_ID);
    expect(found).toBe(true);
  });

  it("proxied /api/health through tunnel", async () => {
    let body: any;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await jar.fetch(
          `${GATEWAY_URL}/s/${SESSION_ID}/api/health`
        );
        body = await res.json();
        if (body) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(body).toBeTruthy();
  });

  it("proxied /api/session returns JSON", async () => {
    const res = await jar.fetch(
      `${GATEWAY_URL}/s/${SESSION_ID}/api/session`
    );
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  it("/api/me returns user info", async () => {
    const res = await jar.fetch(`${GATEWAY_URL}/api/me`);
    const body = await res.json();
    expect(body.email).toBe("alice@example.com");
  });
});
