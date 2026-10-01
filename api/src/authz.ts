import { Hono, type MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { AuthEnv } from "./auth.js";
import type { AccessClaims } from "./token.js";

export interface AuthzRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
}

export interface AuthzOptions {
  /** Empty: everyone who signs in may use sessions. */
  webhookUrl: string;
  webhookToken: string;
  timeoutSeconds: number;
  allowedTtl: number;
  deniedTtl: number;
}

// Evicting everyone bumps the generation, so old entries are never read again and expire.
const key = {
  gen: "orc:v2:authz:gen",
  decision: (gen: string, uid: string) => `orc:v2:authz:${gen}:${uid}`,
};

// Decides whether a signed-in user may list and open remote sessions. The CLI tunnel is
// not checked: anyone may connect their own machine.
export class Authorizer {
  constructor(
    private redis: AuthzRedis,
    private opts: AuthzOptions,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.opts.webhookUrl !== "";
  }

  async allowed(user: AccessClaims): Promise<boolean> {
    if (!this.enabled) return true;
    const gen = (await this.redis.get(key.gen)) ?? "0";
    const cached = await this.redis.get(key.decision(gen, user.uid));
    if (cached !== null) return cached === "1";

    const decision = await this.ask(user);
    // A failed call denies without caching, so the next request asks again.
    if (decision === null) return false;
    const ttl = decision ? this.opts.allowedTtl : this.opts.deniedTtl;
    await this.redis.set(key.decision(gen, user.uid), decision ? "1" : "0", "EX", ttl);
    return decision;
  }

  async evict(uid: string): Promise<void> {
    const gen = (await this.redis.get(key.gen)) ?? "0";
    await this.redis.del(key.decision(gen, uid));
  }

  async evictAll(): Promise<void> {
    await this.redis.incr(key.gen);
  }

  private async ask(user: AccessClaims): Promise<boolean | null> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.webhookToken) headers.Authorization = `Bearer ${this.opts.webhookToken}`;
    try {
      const res = await this.fetchImpl(this.opts.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ user: { uid: user.uid, email: user.email, name: user.name } }),
        signal: AbortSignal.timeout(this.opts.timeoutSeconds * 1000),
      });
      if (!res.ok) {
        console.error(`authz: webhook returned ${res.status} user=${user.uid} email=${user.email}`);
        return null;
      }
      const body = (await res.json()) as { allowed?: unknown; reason?: unknown };
      if (typeof body.allowed !== "boolean") {
        console.error(`authz: webhook response has no boolean allowed user=${user.uid} email=${user.email}`);
        return null;
      }
      const reason = typeof body.reason === "string" ? ` reason=${body.reason}` : "";
      console.log(`authz: user=${user.uid} email=${user.email} allowed=${body.allowed}${reason}`);
      return body.allowed;
    } catch (err) {
      console.error(`authz: webhook failed user=${user.uid} email=${user.email}:`, err);
      return null;
    }
  }
}

export function requireAccess(authorizer: Authorizer): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    let ok: boolean;
    try {
      ok = await authorizer.allowed(c.get("claims"));
    } catch (err) {
      console.error("authz check failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
    if (!ok) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Lets an operator apply an access change now instead of after the cache TTL.
// Without an admin token the routes do not exist.
export function adminRoutes(adminToken: string, authorizer: Authorizer) {
  const app = new Hono();
  if (!adminToken) return app;
  app.use("/admin/*", async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), adminToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.delete("/admin/authz/cache", async (c) => {
    await authorizer.evictAll();
    console.log("authz: cache evicted for all users");
    return c.body(null, 204);
  });
  app.delete("/admin/authz/cache/:uid", async (c) => {
    const uid = c.req.param("uid");
    await authorizer.evict(uid);
    console.log(`authz: cache evicted user=${uid}`);
    return c.body(null, 204);
  });
  return app;
}
