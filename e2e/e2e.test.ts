import { describe, it, expect, beforeAll } from "vitest";
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { API_URL, UI_URL, GATEWAY_URL, OIDC_URL, SESSION_ID, SESSION_ID_V2, PROTOCOL, waitFor, TokenSession, postJson, loginCode, loginAs, upgradeStatus } from "./helpers.js";

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

  it("api and gateway publish the same CLI login config", async () => {
    const expected = { issuer: OIDC_URL, clientId: "opencode-rc-cli" };
    for (const base of [API_URL, GATEWAY_URL]) {
      const res = await fetch(`${base}/auth/cli-config`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected);
    }
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
        if ([SESSION_ID, SESSION_ID_V2].every((id) => sessions.some((s) => s.id === id))) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    const ids = sessions.map((s) => s.id);
    expect(ids, "both dev machines should register their sessions").toEqual(expect.arrayContaining([SESSION_ID, SESSION_ID_V2]));
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
    // The dev machine runs the opencode pinned in cli/Dockerfile; the CLI reports its 1.x version.
    expect(session.opencodeVersion).toMatch(/^1\.\d+\.\d+$/);
  });

  it("session user matches logged-in user", async () => {
    const me = await (await jar.fetch(`${API_URL}/api/me`)).json();
    // Keyed by the sub claim, which the web and CLI clients share.
    expect(me.sub).toBe("user1");
    const res = await jar.fetch(`${API_URL}/gateway/sessions`);
    const sessions: any[] = await res.json();
    const session = sessions.find((s: any) => s.id === SESSION_ID);
    expect(session.user).toBe(me.sub);
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

  it("the UI is built for the API URL", async () => {
    const res = await fetch(`${UI_URL}/`);
    expect(res.headers.get("content-security-policy")).toContain(
      `connect-src 'self' data: ${API_URL} ${API_URL.replace(/^http/, "ws")};`,
    );
    expect((await fetch(`${UI_URL}/config.json`)).headers.get("content-type")).toContain("text/html");
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

describe("access webhook", () => {
  const HOOK_URL = process.env.AUTHZ_HOOK_URL ?? "http://authz-hook:8080";
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "e2e-admin-token";
  const admin = (path: string, token = ADMIN_TOKEN) =>
    fetch(`${API_URL}${path}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  const setDenied = (uid: string, denied: boolean) =>
    fetch(`${HOOK_URL}/deny/${uid}`, { method: denied ? "PUT" : "DELETE" });
  // The stub answers 500 for these uids.
  const setFailing = (uid: string, failing: boolean) =>
    fetch(`${HOOK_URL}/fail/${uid}`, { method: failing ? "PUT" : "DELETE" });

  let aliceJar: TokenSession;
  let bobJar: TokenSession;
  let carolJar: TokenSession;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    aliceJar = await loginAs("user1");
    bobJar = await loginAs("user2");
    carolJar = await loginAs("user3");
  });

  it("a denied user can sign in and is told so by /api/me", async () => {
    const me = await (await carolJar.fetch(`${API_URL}/api/me`)).json();
    expect(me).toMatchObject({ sub: "user3", email: "carol@example.com", allowed: false, reason: "on the e2e deny list" });
    const alice = await (await aliceJar.fetch(`${API_URL}/api/me`)).json();
    expect(alice.allowed).toBe(true);
  });

  it("a denied user cannot list or open sessions", async () => {
    const list = await carolJar.fetch(`${API_URL}/gateway/sessions`);
    expect(list.status).toBe(403);
    expect(await list.json()).toEqual({ error: "forbidden", reason: "on the e2e deny list" });
    const proxy = await carolJar.fetch(`${API_URL}/proxy/${SESSION_ID}/api/health`);
    expect(proxy.status).toBe(403);
    expect(await proxy.json()).toEqual({ error: "forbidden", reason: "on the e2e deny list" });
  });

  it("a revoked owner loses their own session, including the terminal WebSocket", async () => {
    const health = () => aliceJar.fetch(`${API_URL}/proxy/${SESSION_ID}/api/health`);
    const terminal = () =>
      upgradeStatus(
        API_URL.replace(/^http/, "ws") +
          `/proxy/${SESSION_ID}/pty/x/connect?access_token=${encodeURIComponent(aliceJar.access)}`,
      );
    expect((await health()).status).toBe(200);
    try {
      await setDenied("user1", true);
      expect((await admin("/admin/authz/cache/user1")).status).toBe(204);
      expect((await health()).status).toBe(403);
      expect(await terminal()).toBe(403);
    } finally {
      await setDenied("user1", false);
      await admin("/admin/authz/cache/user1");
    }
    expect((await health()).status).toBe(200);
  });

  // Open streams are re-checked every authz.cacheTTL.allowed (5s on e2e).
  it("a revoked owner's open event stream and terminal are closed", async () => {
    const created = await aliceJar.fetch(`${API_URL}/proxy/${SESSION_ID}/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(200);
    const pty = (await created.json()) as { id: string };
    const ws = new WebSocket(
      API_URL.replace(/^http/, "ws") +
        `/proxy/${SESSION_ID}/pty/${pty.id}/connect?cursor=0&access_token=${encodeURIComponent(aliceJar.access)}`,
    );
    const wsClosed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const events = await aliceJar.fetch(`${API_URL}/proxy/${SESSION_ID}/global/event`);
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await reader.read();
    const streamEnded = (async () => {
      while (!(await reader.read()).done);
    })();

    try {
      await setDenied("user1", true);
      expect((await admin("/admin/authz/cache/user1")).status).toBe(204);
      const deadline = (ms: number) => new Promise((_, reject) => setTimeout(() => reject(new Error("not closed")), ms));
      await Promise.race([streamEnded, deadline(15_000)]);
      expect(await Promise.race([wsClosed, deadline(15_000)])).toEqual({ code: 1008, reason: "on the e2e deny list" });
    } finally {
      ws.close();
      await reader.cancel().catch(() => {});
      await setDenied("user1", false);
      await admin("/admin/authz/cache/user1");
    }
  }, 40_000);

  it("signing out closes the session's open event stream", async () => {
    // A sign-in of its own, so aliceJar stays signed in.
    const jar = await loginAs("user1");
    const events = await jar.fetch(`${API_URL}/proxy/${SESSION_ID}/global/event`);
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await reader.read();
    const streamEnded = (async () => {
      while (!(await reader.read()).done);
    })();
    try {
      expect((await postJson("/auth/logout", { refresh_token: jar.refresh })).status).toBe(204);
      const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("not closed")), 15_000));
      await Promise.race([streamEnded, deadline]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }, 30_000);

  it("a failing webhook denies, and the failure is not cached", async () => {
    const sessions = () => bobJar.fetch(`${API_URL}/gateway/sessions`);
    try {
      await setFailing("user2", true);
      expect((await admin("/admin/authz/cache/user2")).status).toBe(204);
      const res = await sessions();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      await setFailing("user2", false);
      // No eviction: an error is never cached, so the next request asks the webhook again.
      expect((await sessions()).status).toBe(200);
    } finally {
      await setFailing("user2", false);
      await admin("/admin/authz/cache/user2");
    }
  });

  it("evicting every user applies a change at once", async () => {
    const sessions = () => bobJar.fetch(`${API_URL}/gateway/sessions`);
    expect((await sessions()).status).toBe(200);
    try {
      await setDenied("user2", true);
      expect((await admin("/admin/authz/cache")).status).toBe(204);
      expect((await sessions()).status).toBe(403);
    } finally {
      await setDenied("user2", false);
      await admin("/admin/authz/cache");
    }
    expect((await sessions()).status).toBe(200);
  });

  it("the admin API requires its token", async () => {
    expect((await admin("/admin/authz/cache", "wrong")).status).toBe(401);
    expect((await fetch(`${API_URL}/admin/authz/cache`, { method: "DELETE" })).status).toBe(401);
  });

  it("a revoked user keeps access until the cache is evicted", async () => {
    try {
      // A fresh allowed decision, cached for authz.cacheTTL.allowed (5s on e2e).
      await admin("/admin/authz/cache/user2");
      expect((await bobJar.fetch(`${API_URL}/gateway/sessions`)).status).toBe(200);
      await setDenied("user2", true);
      expect((await bobJar.fetch(`${API_URL}/gateway/sessions`)).status).toBe(200);
      expect((await admin("/admin/authz/cache/user2")).status).toBe(204);
      expect((await bobJar.fetch(`${API_URL}/gateway/sessions`)).status).toBe(403);
    } finally {
      await setDenied("user2", false);
      await admin("/admin/authz/cache");
    }
    expect((await bobJar.fetch(`${API_URL}/gateway/sessions`)).status).toBe(200);
  });
});

describe("uploads disabled", () => {
  let jar: TokenSession;
  let sessionID: string;
  const proxy = (path: string) => `${API_URL}/proxy/${SESSION_ID}${path}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const upload = { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,iVBORw0KGgo=" };

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
    const res = await jar.fetch(proxy("/session"), json("POST", {}));
    expect(res.status).toBe(200);
    sessionID = (await res.json()).id;
  });

  it("rejects a prompt with an uploaded file", async () => {
    const res = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json("POST", { parts: [upload] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("uploads are disabled");
  });

  it("rejects a v2 prompt with an uploaded file", async () => {
    const body = { prompt: { text: "hi", files: [{ uri: upload.url }] } };
    const res = await jar.fetch(proxy(`/api/session/${sessionID}/prompt`), json("POST", body));
    expect(res.status).toBe(403);
  });

  it("rejects an uploaded project icon", async () => {
    const res = await jar.fetch(proxy("/project/any"), json("PATCH", { icon: { override: upload.url } }));
    expect(res.status).toBe(403);
  });

  it("still accepts a text prompt, and lets an @mention through to the downloads guard", async () => {
    const text = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json("POST", { parts: [{ type: "text", text: "hi" }] }));
    expect(text.status).toBe(204);
    // e2e also disables downloads, which refuses file: parts. The uploads guard runs first, so
    // the downloads message shows the uploads guard let the part through (also covered by the
    // API unit tests, upload-guard.test.ts).
    const mention = { type: "file", mime: "text/plain", filename: "a.txt", url: "file:///project/a.txt" };
    const res = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json("POST", { parts: [mention] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("file downloads are disabled");
  });
});

describe("downloads disabled", () => {
  let jar: TokenSession;
  const proxy = (path: string) => `${API_URL}/proxy/${SESSION_ID}${path}`;
  // mounted into /project on the dev machine (e2e/k8s/dev-machine.yaml)
  const file = "/project/opencode.json";

  let sessionID: string;
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
    const res = await jar.fetch(proxy("/session"), json({}));
    expect(res.status).toBe(200);
    sessionID = (await res.json()).id;
  });

  it("refuses file contents and text search", async () => {
    // The file exists: the allowed listing shows it, so the 403 is the toggle, not a missing file.
    const listing = await jar.fetch(proxy(`/file?path=${encodeURIComponent("/project")}`));
    expect(listing.status).toBe(200);
    expect(JSON.stringify(await listing.json())).toContain("opencode.json");
    for (const path of [
      `/file/content?path=${encodeURIComponent(file)}`,
      `/api/fs/read${file}`,
      `/find?pattern=model`,
    ]) {
      const res = await jar.fetch(proxy(path));
      expect(res.status, path).toBe(403);
      expect(await res.text()).toBe("file downloads are disabled");
    }
  });

  it("still lists files and finds them by name", async () => {
    expect((await jar.fetch(proxy(`/file?path=${encodeURIComponent("/project")}`))).status).toBe(200);
    expect((await jar.fetch(proxy(`/find/file?query=opencode&dirs=false`))).status).toBe(200);
  });

  it("refuses a prompt that references a file", async () => {
    const part = { type: "file", mime: "text/plain", filename: "opencode.json", url: `file://${file}` };
    const res = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json({ parts: [part] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("file downloads are disabled");
  });

  it("refuses a command whose arguments reference a file", async () => {
    const res = await jar.fetch(proxy(`/session/${sessionID}/command`), json({ command: "init", arguments: "@opencode.json", parts: [] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("file downloads are disabled");
  });

  it("still accepts a text prompt", async () => {
    const res = await jar.fetch(proxy(`/session/${sessionID}/prompt_async`), json({ parts: [{ type: "text", text: "hi user@example.com" }] }));
    expect(res.status).toBe(204);
  });

  // opencode puts the file's contents in place of {file:path} when it loads the config.
  it("refuses a config value that reads a file, and stores nothing", async () => {
    const before = await jar.fetch(proxy("/global/config"));
    expect(before.status).toBe(200);
    const config = await before.json();
    const res = await jar.fetch(proxy("/global/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: `{file:${file}}` }),
    });
    expect(res.status).toBe(403);
    // config is disabled too; downloads answers first because it comes before config in FEATURES.
    expect(await res.text()).toBe("file downloads are disabled");
    const after = await jar.fetch(proxy("/global/config"));
    expect(after.status).toBe(200);
    const text = await after.text();
    expect(text).not.toContain("{file:");
    expect(JSON.parse(text)).toEqual(config);
  });
});

describe("config disabled", () => {
  let jar: TokenSession;
  const proxy = (path: string) => `${API_URL}/proxy/${SESSION_ID}${path}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("refuses a global config update", async () => {
    const res = await jar.fetch(proxy("/global/config"), json("PATCH", { disabled_providers: [] }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("config changes are disabled");
  });

  it("refuses adding an MCP server", async () => {
    const res = await jar.fetch(proxy("/mcp"), json("POST", { name: "docs", config: { type: "remote", url: "https://example.com/mcp" } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("config changes are disabled");
  });

  it("refuses project commands, and lets a name edit through to opencode", async () => {
    const refused = await jar.fetch(proxy("/project/any"), json("PATCH", { commands: { start: "" } }));
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("config changes are disabled");
    // The guard lets it pass; opencode answers for the unknown project.
    const passed = await jar.fetch(proxy("/project/any"), json("PATCH", { name: "e2e" }));
    expect(await passed.text()).not.toBe("config changes are disabled");
  });

  it("still serves the config", async () => {
    expect((await jar.fetch(proxy("/config"))).status).toBe(200);
  });
});

describe("mcp disabled", () => {
  let jar: TokenSession;
  const proxy = (path: string) => `${API_URL}/proxy/${SESSION_ID}${path}`;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it("refuses connecting an MCP server", async () => {
    const res = await jar.fetch(proxy("/mcp/docs/connect"), { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("MCP changes are disabled");
  });

  it("still lists MCP servers", async () => {
    expect((await jar.fetch(proxy("/mcp"))).status).toBe(200);
  });
});

describe("1.x routes refused whatever the toggles", () => {
  let jar: TokenSession;
  const proxy = (path: string) => `${API_URL}/proxy/${SESSION_ID}${path}`;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  it.each(["/vcs/apply", "/tui/show-toast"])("refuses POST %s", async (path) => {
    const res = await jar.fetch(proxy(path), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("this opencode route is not available through opencode-rc");
  });
});

describe("1.x provider responses have no API keys", () => {
  let jar: TokenSession;
  const proxy = (path: string) => `${API_URL}/proxy/${SESSION_ID}${path}`;

  beforeAll(async () => {
    await waitFor("api", `${API_URL}/healthz`, 30);
    jar = await loginAs("user1");
  });

  // alice-dev runs with OPENAI_API_KEY=mock, which opencode returns as the openai provider's key,
  // and its opencode.json sets openai's options (baseURL).
  it.each([
    ["/provider", "all"],
    ["/config/providers", "providers"],
  ])("GET %s lists openai without its key or options", async (path, field) => {
    const res = await jar.fetch(proxy(path));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"mock"');
    type Item = { id: string; models: Record<string, Record<string, unknown>> };
    const providers = (JSON.parse(text) as Record<string, Item[]>)[field];
    expect(providers.some((p) => "key" in p || "options" in p)).toBe(false);
    expect(providers.some((p) => Object.values(p.models).some((m) => "options" in m || "headers" in m))).toBe(false);
    const openai = providers.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(Object.keys(openai!.models).length).toBeGreaterThan(0);
  });

  it("GET /config keeps the openai provider without its options", async () => {
    const res = await jar.fetch(proxy("/config"));
    expect(res.status).toBe(200);
    const config = (await res.json()) as { model?: string; provider?: Record<string, Record<string, unknown>> };
    expect(config.model).toBe("openai/gpt-4o");
    expect(config.provider?.openai).toBeDefined();
    expect("options" in config.provider!.openai).toBe(false);
  });
});
