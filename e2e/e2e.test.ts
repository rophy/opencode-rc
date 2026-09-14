import { describe, it, expect, beforeAll } from "vitest";

const GATEWAY_URL = "http://gateway:8080";
const TUNNELER_URL = "http://tunneler:9090";
const OIDC_URL = "http://oidc-mock:8080";
const OIDC_CLIENT_ID = process.env.GATEWAY_OIDC_CLIENT_ID ?? "opencode-rc";
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
      if (name) this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()]
      .filter(([, v]) => v)
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

async function loginAs(jar: CookieJar, sub: string): Promise<void> {
  const startRes = await jar.fetch(`${GATEWAY_URL}/auth/start`);
  const redirectUrl = startRes.headers.get("location")!;
  const url = new URL(redirectUrl);

  const callbackRes = await fetch(`${OIDC_URL}/authorize/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      sub,
      client_id: OIDC_CLIENT_ID,
      redirect_uri: url.searchParams.get("redirect_uri")!,
      state: url.searchParams.get("state")!,
      nonce: "",
      scope: "openid email profile",
      code_challenge: "",
      code_challenge_method: "",
    }),
    redirect: "manual",
  });
  const callbackUrl = callbackRes.headers.get("location")!;
  await jar.fetch(callbackUrl);
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
    await loginAs(jar, "user1");
    expect(jar.header()).toContain("orc_session=");
  });

  it("dashboard accessible with session cookie", async () => {
    const res = await jar.fetch(`${GATEWAY_URL}/`);
    expect(res.status).toBe(200);
  });

  it("dev-machine tunnel connected", async () => {
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

describe("auth edge cases", () => {
  beforeAll(async () => {
    await waitFor("gateway", `${GATEWAY_URL}/healthz`, 30);
  });

  it("unauthenticated /api/me redirects to login", async () => {
    const res = await fetch(`${GATEWAY_URL}/api/me`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("unauthenticated /gateway/sessions redirects to login", async () => {
    const res = await fetch(`${GATEWAY_URL}/gateway/sessions`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("unauthenticated / redirects to login", async () => {
    const res = await fetch(`${GATEWAY_URL}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("unauthenticated session proxy redirects to login", async () => {
    const res = await fetch(
      `${GATEWAY_URL}/s/${SESSION_ID}/api/health`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("logout clears session and redirects", async () => {
    const jar = new CookieJar();
    await loginAs(jar, "user1");

    const meRes = await jar.fetch(`${GATEWAY_URL}/api/me`);
    expect(meRes.status).toBe(200);

    const logoutRes = await jar.fetch(`${GATEWAY_URL}/auth/logout`);
    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get("location")).toBe("/");

    const afterRes = await jar.fetch(`${GATEWAY_URL}/api/me`);
    expect(afterRes.status).toBe(302);
    expect(afterRes.headers.get("location")).toBe("/auth/login");
  });
});

describe("multi-user isolation", () => {
  const aliceJar = new CookieJar();
  const bobJar = new CookieJar();

  beforeAll(async () => {
    await waitFor("gateway", `${GATEWAY_URL}/healthz`, 30);
    await loginAs(aliceJar, "user1");
    await loginAs(bobJar, "user2");
  });

  it("alice /api/me returns alice", async () => {
    const res = await aliceJar.fetch(`${GATEWAY_URL}/api/me`);
    const body = await res.json();
    expect(body.email).toBe("alice@example.com");
    expect(body.name).toBe("Alice");
  });

  it("bob /api/me returns bob", async () => {
    const res = await bobJar.fetch(`${GATEWAY_URL}/api/me`);
    const body = await res.json();
    expect(body.email).toBe("bob@example.com");
    expect(body.name).toBe("Bob");
  });

  it("alice sees her own sessions", async () => {
    const res = await aliceJar.fetch(`${GATEWAY_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.id === SESSION_ID)).toBe(true);
  });

  it("bob does not see alice's sessions", async () => {
    const res = await bobJar.fetch(`${GATEWAY_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const hasAlice = sessions.some((s) => s.id === SESSION_ID);
    expect(hasAlice).toBe(false);
  });

  it("bob cannot proxy to alice's session", async () => {
    const res = await bobJar.fetch(
      `${GATEWAY_URL}/s/${SESSION_ID}/api/health`
    );
    expect(res.status).toBe(404);
  });
});

describe("api error handling", () => {
  const jar = new CookieJar();

  beforeAll(async () => {
    await waitFor("gateway", `${GATEWAY_URL}/healthz`, 30);
    await loginAs(jar, "user1");
  });

  it("healthz includes version field", async () => {
    const res = await fetch(`${GATEWAY_URL}/healthz`);
    const body = await res.json();
    expect(body).toHaveProperty("version");
    expect(typeof body.version).toBe("string");
  });

  it("invalid session ID returns 404", async () => {
    const res = await jar.fetch(
      `${GATEWAY_URL}/s/nonexistent-session/api/health`
    );
    expect(res.status).toBe(404);
  });

  it("OIDC discovery endpoint is accessible", async () => {
    const res = await fetch(
      `${OIDC_URL}/.well-known/openid-configuration`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("issuer");
    expect(body).toHaveProperty("authorization_endpoint");
    expect(body).toHaveProperty("token_endpoint");
  });
});

describe("tunnel auth", () => {
  beforeAll(async () => {
    await waitFor("tunneler", `${TUNNELER_URL}/healthz`, 30);
  });

  it("tunneler /tunnel without auth returns 401", async () => {
    const res = await fetch(`${TUNNELER_URL}/tunnel`);
    expect(res.status).toBe(401);
  });

  it("tunneler /tunnel with invalid bearer returns 401", async () => {
    const res = await fetch(`${TUNNELER_URL}/tunnel`, {
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  it("tunneler /tunnel with malformed auth header returns 401", async () => {
    const res = await fetch(`${TUNNELER_URL}/tunnel`, {
      headers: { authorization: "NotBearer something" },
    });
    expect(res.status).toBe(401);
  });
});
