import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { Authorizer, adminRoutes, requireAccess, type AuthzOptions } from "./authz.js";
import { MockRedis } from "./testing/mock-redis.js";
import type { AuthEnv } from "./auth.js";

const alice = { uid: "alice-id", email: "alice@example.com", name: "Alice" };
const bob = { uid: "bob-id", email: "bob@example.com", name: "Bob" };

const opts: AuthzOptions = {
  webhookUrl: "http://authz.example.com/check",
  webhookToken: "",
  timeoutSeconds: 5,
  allowedTtl: 60,
  deniedTtl: 10,
};

let redis: MockRedis;
let hook: ReturnType<typeof vi.fn>;
let decide: (uid: string) => Response | Promise<Response>;

function authorizer(o: Partial<AuthzOptions> = {}) {
  return new Authorizer(redis, { ...opts, ...o }, hook as unknown as typeof fetch);
}

beforeEach(() => {
  redis = new MockRedis();
  decide = (uid) => Response.json({ allowed: uid === alice.uid });
  hook = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { user: { uid: string } };
    return decide(body.user.uid);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("Authorizer", () => {
  it("allows everyone without calling anything when no webhook is set", async () => {
    const a = authorizer({ webhookUrl: "" });
    expect(a.enabled).toBe(false);
    expect(await a.allowed(bob)).toBe(true);
    expect(hook).not.toHaveBeenCalled();
  });

  it("posts the user to the webhook and returns its decision", async () => {
    const a = authorizer();
    expect(await a.allowed(alice)).toBe(true);
    expect(await a.allowed(bob)).toBe(false);
    const [url, init] = hook.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(opts.webhookUrl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ user: alice });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("sends the webhook token as a bearer", async () => {
    await authorizer({ webhookToken: "hook-secret" }).allowed(alice);
    const init = hook.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer hook-secret");
  });

  it("caches allowed decisions for the allowed TTL", async () => {
    const a = authorizer();
    await a.allowed(alice);
    redis.advance(59);
    await a.allowed(alice);
    expect(hook).toHaveBeenCalledTimes(1);
    redis.advance(1);
    await a.allowed(alice);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("caches denied decisions for the denied TTL", async () => {
    const a = authorizer();
    await a.allowed(bob);
    redis.advance(9);
    await a.allowed(bob);
    expect(hook).toHaveBeenCalledTimes(1);
    redis.advance(1);
    decide = () => Response.json({ allowed: true });
    expect(await a.allowed(bob)).toBe(true);
  });

  it.each([
    ["an error status", () => new Response("boom", { status: 500 })],
    ["a missing allowed field", () => Response.json({ ok: true })],
    ["a non-boolean allowed field", () => Response.json({ allowed: "yes" })],
    ["invalid JSON", () => new Response("not json")],
    [
      "a network error",
      () => {
        throw new Error("connection refused");
      },
    ],
  ])("denies without caching on %s", async (_name, response) => {
    decide = response;
    const a = authorizer();
    expect(await a.allowed(alice)).toBe(false);
    decide = () => Response.json({ allowed: true });
    expect(await a.allowed(alice)).toBe(true);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("denies when the webhook times out", async () => {
    hook = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    );
    expect(await authorizer({ timeoutSeconds: 0.01 }).allowed(alice)).toBe(false);
  });

  it("evicts one user", async () => {
    const a = authorizer();
    await a.allowed(alice);
    await a.allowed(bob);
    await a.evict(bob.uid);
    await a.allowed(alice);
    await a.allowed(bob);
    expect(hook.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).user.uid)).toEqual([
      alice.uid,
      bob.uid,
      bob.uid,
    ]);
  });

  it("evicts every user", async () => {
    const a = authorizer();
    await a.allowed(alice);
    await a.allowed(bob);
    await a.evictAll();
    await a.allowed(alice);
    await a.allowed(bob);
    expect(hook).toHaveBeenCalledTimes(4);
  });
});

describe("requireAccess", () => {
  function app(a: Authorizer) {
    const app = new Hono<AuthEnv>();
    app.get(
      "/x/:uid",
      async (c, next) => {
        c.set("claims", c.req.param("uid") === alice.uid ? alice : bob);
        await next();
      },
      requireAccess(a),
      (c) => c.text("ok"),
    );
    return app;
  }

  it("passes allowed users through", async () => {
    const res = await app(authorizer()).request(`/x/${alice.uid}`);
    expect(res.status).toBe(200);
  });

  it("returns 403 for denied users", async () => {
    const res = await app(authorizer()).request(`/x/${bob.uid}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("returns 503 when the cache is unavailable", async () => {
    vi.spyOn(redis, "get").mockRejectedValue(new Error("redis down"));
    const res = await app(authorizer()).request(`/x/${alice.uid}`);
    expect(res.status).toBe(503);
  });
});

describe("adminRoutes", () => {
  const del = (app: Hono, path: string, token?: string) =>
    app.request(path, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it("does not exist without an admin token", async () => {
    const res = await del(adminRoutes("", authorizer()), "/admin/authz/cache", "");
    expect(res.status).toBe(404);
  });

  it.each([undefined, "wrong", "admin-secretx"])("rejects token %s", async (token) => {
    const res = await del(adminRoutes("admin-secret", authorizer()), "/admin/authz/cache", token);
    expect(res.status).toBe(401);
  });

  it("evicts one user", async () => {
    const a = authorizer();
    await a.allowed(bob);
    const res = await del(adminRoutes("admin-secret", a), `/admin/authz/cache/${bob.uid}`, "admin-secret");
    expect(res.status).toBe(204);
    await a.allowed(bob);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("evicts every user", async () => {
    const a = authorizer();
    await a.allowed(alice);
    const res = await del(adminRoutes("admin-secret", a), "/admin/authz/cache", "admin-secret");
    expect(res.status).toBe(204);
    await a.allowed(alice);
    expect(hook).toHaveBeenCalledTimes(2);
  });
});
