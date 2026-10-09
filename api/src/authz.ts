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

/** The webhook's optional reason for a denial, shown to the user. */
export interface Decision {
  allowed: boolean;
  reason?: string;
}

const MAX_REASON = 300;

/** Starts re-checking the user of an open stream; onDenied runs once on a denial. Returns stop. */
export type AccessWatch = (onDenied: (decision: Decision) => void) => () => void;

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
    return (await this.check(user)).allowed;
  }

  async check(user: AccessClaims): Promise<Decision> {
    if (!this.enabled) return { allowed: true };
    const gen = (await this.redis.get(key.gen)) ?? "0";
    const cached = await this.redis.get(key.decision(gen, user.uid));
    // Cached as "1", "0" or "0:<reason>".
    if (cached !== null) {
      if (cached === "1") return { allowed: true };
      return cached.startsWith("0:") ? { allowed: false, reason: cached.slice(2) } : { allowed: false };
    }

    const decision = await this.ask(user);
    // A failed call denies without caching, so the next request asks again.
    if (decision === null) return { allowed: false };
    const ttl = decision.allowed ? this.opts.allowedTtl : this.opts.deniedTtl;
    const value = decision.allowed ? "1" : decision.reason ? `0:${decision.reason}` : "0";
    await this.redis.set(key.decision(gen, user.uid), value, "EX", ttl);
    return decision;
  }

  // Re-checks the user of a stream that stays open (event stream, terminal) each time a cached
  // "allowed" expires, so a revocation ends it within allowedTtl. A check that fails (Redis
  // down) keeps the stream and retries at the next tick, as a new request gets 503, not 403.
  watch(user: AccessClaims, onDenied: (decision: Decision) => void): () => void {
    if (!this.enabled) return () => {};
    let stopped = false;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const decision = await this.check(user);
        if (!decision.allowed && !stopped) {
          stop();
          console.log(`authz: closing open stream user=${user.uid} email=${user.email}`);
          onDenied(decision);
        }
      } catch (err) {
        console.error(`authz: re-check failed user=${user.uid}:`, err);
      } finally {
        busy = false;
      }
    }, this.opts.allowedTtl * 1000);
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    return stop;
  }

  async evict(uid: string): Promise<void> {
    const gen = (await this.redis.get(key.gen)) ?? "0";
    await this.redis.del(key.decision(gen, uid));
  }

  async evictAll(): Promise<void> {
    await this.redis.incr(key.gen);
  }

  private async ask(user: AccessClaims): Promise<Decision | null> {
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
      const reason = typeof body.reason === "string" && body.reason ? body.reason.slice(0, MAX_REASON) : undefined;
      console.log(`authz: user=${user.uid} email=${user.email} allowed=${body.allowed}${reason ? ` reason=${reason}` : ""}`);
      if (body.allowed) return { allowed: true };
      return reason ? { allowed: false, reason } : { allowed: false };
    } catch (err) {
      console.error(`authz: webhook failed user=${user.uid} email=${user.email}:`, err);
      return null;
    }
  }
}

// Also hands the route a watch for streams it keeps open (c.get("watchAccess")).
export function requireAccess(authorizer: Authorizer): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const claims = c.get("claims");
    let decision: Decision;
    try {
      decision = await authorizer.check(claims);
    } catch (err) {
      console.error("authz check failed:", err);
      return c.json({ error: "unavailable" }, 503);
    }
    if (!decision.allowed) {
      return c.json({ error: "forbidden", ...(decision.reason ? { reason: decision.reason } : {}) }, 403);
    }
    c.set("watchAccess", (onDenied) => authorizer.watch(claims, onDenied));
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
