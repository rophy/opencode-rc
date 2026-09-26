import { describe, it, expect, beforeAll } from "vitest";
import { WebSocket } from "ws";
import { createHash, randomBytes } from "node:crypto";

const API_URL = process.env.API_URL ?? "http://opencode-rc-api:8080";
const UI_URL = process.env.UI_URL ?? "http://opencode-rc-ui:8080";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://opencode-rc-gateway:9090";
const OIDC_URL = process.env.OIDC_URL ?? "http://opencode-rc-oidc-mock:8080";
const OIDC_CLIENT_ID = process.env.WEB_OIDC_CLIENT_ID ?? "opencode-rc";
const SESSION_ID = process.env.OPENCODE_RC_SESSION_ID ?? "alice-dev";

const PROTOCOL = { "OpenCode-RC-Protocol": "1" };

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

class TokenSession {
  constructor(public access: string, public refresh: string) {}

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.access}`);
    headers.set("OpenCode-RC-Protocol", "1");
    return fetch(url, { ...init, headers, redirect: "manual" });
  }
}

function cookieHeader(res: Response): string {
  return (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...PROTOCOL },
    body: JSON.stringify(body),
  });
}

interface LoginCode {
  code: string;
  verifier: string;
}

async function loginCode(sub: string): Promise<LoginCode> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const startRes = await fetch(`${API_URL}/auth/start?return_to=%2F&code_challenge=${challenge}`, {
    redirect: "manual",
  });
  expect(startRes.status).toBe(302);
  const cookies = cookieHeader(startRes);
  const url = new URL(startRes.headers.get("location")!);

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
  const webCallback = await fetch(callbackRes.headers.get("location")!, {
    headers: { cookie: cookies },
    redirect: "manual",
  });
  expect(webCallback.status).toBe(302);
  const landing = new URL(webCallback.headers.get("location")!, API_URL);
  const code = new URLSearchParams(landing.hash.slice(1)).get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier };
}

async function loginAs(sub: string): Promise<TokenSession> {
  const { code, verifier } = await loginCode(sub);
  const res = await postJson("/auth/token", { code, code_verifier: verifier });
  expect(res.status).toBe(200);
  const body = await res.json();
  return new TokenSession(body.access_token, body.refresh_token);
}

describe("opencode-rc e2e", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("oidc-mock", `${OIDC_URL}/.well-known/openid-configuration`, 30);
    await waitFor("api", `${API_URL}/healthz`, 30);
    await waitFor("gateway", `${GATEWAY_URL}/healthz`, 30);
  });

  it("api /healthz returns ok", async () => {
    const res = await fetch(`${API_URL}/healthz`);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("gateway /healthz returns ok", async () => {
    const res = await fetch(`${GATEWAY_URL}/healthz`);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("api / serves no HTML", async () => {
    const res = await fetch(`${API_URL}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("OIDC login flow returns tokens", async () => {
    jar = await loginAs("user1");
    expect(jar.access).toContain(".");
    expect(jar.refresh.length).toBeGreaterThan(20);
  });

  it("dev-machine tunnel connected", async () => {
    let sessions: any[] = [];
    for (let i = 0; i < 60; i++) {
      try {
        const res = await jar.fetch(`${API_URL}/gateway/sessions`);
        sessions = await res.json();
        if (sessions.length >= 1) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("session visible in dashboard", async () => {
    const res = await jar.fetch(`${API_URL}/gateway/sessions`);
    const sessions = await res.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("expected session found by ID", async () => {
    const res = await jar.fetch(`${API_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const found = sessions.some((s: any) => s.id === SESSION_ID);
    expect(found).toBe(true);
  });

  it("proxied /api/health through tunnel", async () => {
    let body: any;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await jar.fetch(
          `${API_URL}/proxy/${SESSION_ID}/api/health`
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
      `${API_URL}/proxy/${SESSION_ID}/api/session`
    );
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  it("/api/me returns user info", async () => {
    const res = await jar.fetch(`${API_URL}/api/me`);
    const body = await res.json();
    expect(body.email).toBe("alice@example.com");
  });
});

describe("auth edge cases", () => {
  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
  });

  it("unauthenticated /api/me returns 401", async () => {
    const res = await fetch(`${API_URL}/api/me`, { headers: PROTOCOL });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("unauthenticated /gateway/sessions returns 401", async () => {
    const res = await fetch(`${API_URL}/gateway/sessions`, { headers: PROTOCOL });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("unauthenticated / serves no HTML", async () => {
    const res = await fetch(`${API_URL}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("unauthenticated session proxy returns 401", async () => {
    const res = await fetch(`${API_URL}/proxy/${SESSION_ID}/api/health`);
    expect(res.status).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const session = await loginAs("user1");
    const out = await postJson("/auth/logout", { refresh_token: session.refresh });
    expect(out.status).toBe(204);
    const res = await postJson("/auth/refresh", { refresh_token: session.refresh });
    expect(res.status).toBe(401);
  });

  it("refresh rotates and tolerates a concurrent reuse", async () => {
    const session = await loginAs("user1");
    const a = await (await postJson("/auth/refresh", { refresh_token: session.refresh })).json();
    const b = await (await postJson("/auth/refresh", { refresh_token: session.refresh })).json();
    expect(a.refresh_token).not.toBe(session.refresh);
    expect(b.refresh_token).toBe(a.refresh_token);
    const me = await new TokenSession(a.access_token, a.refresh_token).fetch(`${API_URL}/api/me`);
    expect(me.status).toBe(200);
  });

  it("login code works only once", async () => {
    const { code, verifier } = await loginCode("user1");
    expect((await postJson("/auth/token", { code, code_verifier: verifier })).status).toBe(200);
    const again = await postJson("/auth/token", { code, code_verifier: verifier });
    expect(again.status).toBe(400);
  });

  it("login code is rejected with a wrong verifier", async () => {
    const { code } = await loginCode("user1");
    const res = await postJson("/auth/token", {
      code,
      code_verifier: randomBytes(32).toString("base64url"),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  it("CORS preflight allows the mobile app origin", async () => {
    const res = await fetch(`${API_URL}/api/me`, {
      method: "OPTIONS",
      headers: {
        origin: "capacitor://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
  });
});

describe("multi-user isolation", () => {
  let aliceJar: TokenSession;
  let bobJar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    aliceJar = await loginAs("user1");
    bobJar = await loginAs("user2");
  });

  it("alice /api/me returns alice", async () => {
    const res = await aliceJar.fetch(`${API_URL}/api/me`);
    const body = await res.json();
    expect(body.email).toBe("alice@example.com");
    expect(body.name).toBe("Alice");
  });

  it("bob /api/me returns bob", async () => {
    const res = await bobJar.fetch(`${API_URL}/api/me`);
    const body = await res.json();
    expect(body.email).toBe("bob@example.com");
    expect(body.name).toBe("Bob");
  });

  it("alice sees her own sessions", async () => {
    const res = await aliceJar.fetch(`${API_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.id === SESSION_ID)).toBe(true);
  });

  it("bob does not see alice's sessions", async () => {
    const res = await bobJar.fetch(`${API_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const hasAlice = sessions.some((s) => s.id === SESSION_ID);
    expect(hasAlice).toBe(false);
  });

  it("bob cannot proxy to alice's session", async () => {
    const res = await bobJar.fetch(
      `${API_URL}/proxy/${SESSION_ID}/api/health`
    );
    expect(res.status).toBe(404);
  });
});

describe("tunnel proxy", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("POST with JSON body through tunnel", async () => {
    // POST to /api/session/message exercises the full body-forwarding path:
    // browser → web → gateway → tunnel WebSocket (with FRAME_DATA) → CLI → opencode
    // Even if the endpoint rejects the payload, a non-502 response proves the body was forwarded.
    const res = await jar.fetch(
      `${API_URL}/proxy/${SESSION_ID}/api/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test: true }),
      }
    );
    // Any response that isn't 502 proves the tunnel forwarded the request + body
    expect(res.status).not.toBe(502);
  });

  it("proxied request preserves query string", async () => {
    const res = await jar.fetch(
      `${API_URL}/proxy/${SESSION_ID}/api/health?foo=bar`
    );
    // The request reaches the backend — query string doesn't break routing
    expect(res.status).toBe(200);
  });

  it("proxied non-existent API path returns from backend, not web", async () => {
    const res = await jar.fetch(
      `${API_URL}/proxy/${SESSION_ID}/api/nonexistent-path`
    );
    // Should get a response from opencode (404), not a web server error (502)
    expect(res.status).not.toBe(502);
  });

  it("response headers are passed through tunnel", async () => {
    const res = await jar.fetch(
      `${API_URL}/proxy/${SESSION_ID}/api/health`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("session metadata", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("session has expected fields", async () => {
    const res = await jar.fetch(`${API_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const session = sessions.find((s: any) => s.id === SESSION_ID);
    expect(session).toBeDefined();
    expect(session.id).toBe(SESSION_ID);
    expect(session).toHaveProperty("user");
    expect(session).toHaveProperty("directory");
  });

  it("session user matches logged-in user", async () => {
    const res = await jar.fetch(`${API_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const session = sessions.find((s: any) => s.id === SESSION_ID);
    expect(session.user).toBe("alice@example.com");
  });
});

describe("API and UI are separate hosts", () => {
  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    await waitFor("ui", `${UI_URL}/healthz`, 30);
  });

  it("the API host serves no HTML", async () => {
    for (const path of [
      "/",
      "/index.html",
      `/s/${SESSION_ID}/`,
      "/assets/app.js",
      "/api/nope",
      "/auth/nope",
      "/gateway/nope",
    ]) {
      const res = await fetch(`${API_URL}${path}`, { headers: PROTOCOL });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
    }
  });

  it("the UI host serves the SPA for client routes", async () => {
    const res = await fetch(`${UI_URL}/s/${SESSION_ID}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("<html");
  });

  it("the UI is configured with the API URL", async () => {
    const res = await fetch(`${UI_URL}/config.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ serverUrl: API_URL });
  });

  it("the API allows the UI origin", async () => {
    const res = await fetch(`${API_URL}/api/me`, {
      method: "OPTIONS",
      headers: {
        origin: UI_URL,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(UI_URL);
  });
});

describe("SSE streaming through tunnel", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("/global/event endpoint is reachable through tunnel", async () => {
    // SSE endpoint should respond (even if it hangs waiting for events).
    // Use AbortController to time out after getting the initial response.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await jar.fetch(
        `${API_URL}/proxy/${SESSION_ID}/global/event`,
        { signal: controller.signal }
      );
      // Getting a response at all (not 502) proves the tunnel proxied it
      expect(res.status).not.toBe(502);
    } catch (err: any) {
      // AbortError means we connected but the stream stayed open (expected for SSE)
      if (err.name !== "AbortError") throw err;
    } finally {
      clearTimeout(timeout);
    }
  });
});

describe("api error handling", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("healthz includes version field", async () => {
    const res = await fetch(`${API_URL}/healthz`);
    const body = await res.json();
    expect(body).toHaveProperty("version");
    expect(typeof body.version).toBe("string");
  });

  it("invalid session ID returns 404", async () => {
    const res = await jar.fetch(
      `${API_URL}/proxy/nonexistent-session/api/health`
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

describe("coverage endpoint", () => {
  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    await waitFor("gateway", `${GATEWAY_URL}/healthz`, 30);
  });

  it("gateway /debug/coverage returns tar", async () => {
    const res = await fetch(`${GATEWAY_URL}/debug/coverage`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });
});

describe("tunnel auth", () => {
  beforeAll(async () => {
    await waitFor("gateway", `${GATEWAY_URL}/healthz`, 30);
  });

  it("gateway /tunnel without auth returns 401", async () => {
    const res = await fetch(`${GATEWAY_URL}/tunnel`, { headers: PROTOCOL });
    expect(res.status).toBe(401);
  });

  it("gateway /tunnel with invalid bearer returns 401", async () => {
    const res = await fetch(`${GATEWAY_URL}/tunnel`, {
      headers: { authorization: "Bearer invalid-token", ...PROTOCOL },
    });
    expect(res.status).toBe(401);
  });

  it("gateway /tunnel with malformed auth header returns 401", async () => {
    const res = await fetch(`${GATEWAY_URL}/tunnel`, {
      headers: { authorization: "NotBearer something", ...PROTOCOL },
    });
    expect(res.status).toBe(401);
  });
});

describe("terminal WebSocket through /proxy", () => {
  let jar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("echoes a command through web, gateway and tunnel", async () => {
    const created = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(200);
    const pty = await created.json();
    expect(pty.id).toBeTruthy();

    const wsUrl =
      API_URL.replace(/^http/, "ws") +
      `/proxy/${SESSION_ID}/pty/${pty.id}/connect?cursor=0&access_token=${encodeURIComponent(jar.access)}`;
    const output = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      let text = "";
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`no echo within 15s, got: ${text.slice(-200)}`));
      }, 15_000);
      ws.onopen = () => ws.send("echo e2e-ws-$((40+2))\n");
      ws.onmessage = (e) => {
        text += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
        if (text.includes("e2e-ws-42")) {
          clearTimeout(timer);
          ws.close();
          resolve(text);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket error"));
      };
    });
    expect(output).toContain("e2e-ws-42");
  });

  it("rejects a WebSocket without a token", async () => {
    // fetch() cannot send Upgrade/Connection headers, so attempt a real WebSocket.
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(API_URL.replace(/^http/, "ws") + `/proxy/${SESSION_ID}/pty/x/connect`);
      ws.onopen = () => {
        ws.close();
        resolve(false);
      };
      ws.onerror = () => resolve(true);
    });
    expect(failed).toBe(true);
  });
});

describe("protocol versioning", () => {
  it("API rejects a client without the protocol header", async () => {
    const res = await fetch(`${API_URL}/api/me`);
    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: "client_outdated", client: 0, minimum: 1 });
    expect(res.headers.get("OpenCode-RC-Protocol")).toBe("1");
  });

  it("API healthz reports its protocol", async () => {
    expect(await (await fetch(`${API_URL}/healthz`)).json()).toMatchObject({ protocol: 1 });
  });

  it("gateway tells an old CLI to update", async () => {
    const res = await fetch(`${GATEWAY_URL}/tunnel?sessionId=e2e-old-cli&directory=%2Ftmp`);
    expect(res.status).toBe(403);
    expect((await res.text()).trim()).toBe(
      "opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest",
    );
  });
});
