import type { Handler, MiddlewareHandler } from "hono";
import type { SessionStore, SessionMeta } from "./store.js";
import type { AuthEnv } from "./auth.js";

// Under Bun, Hono's env is the Bun server.
type ServerEnv = { Bindings: { timeout?: (request: Request, seconds: number) => void } | undefined };

export type ProxyEnv = AuthEnv & ServerEnv & { Variables: { session: SessionMeta } };

export function proxyRest(path: string, sessionId: string): string {
  const rest = path.slice(`/proxy/${sessionId}`.length).replace(/\/{2,}/g, "/");
  return rest.startsWith("/") ? rest : `/${rest}`;
}

export function upstreamUrl(
  scheme: "http" | "ws",
  gatewayAddr: string,
  sessionId: string,
  rest: string,
  search: string,
): string {
  const params = new URLSearchParams(search);
  params.delete("access_token");
  const qs = params.toString();
  return `${scheme}://${gatewayAddr}/proxy/${sessionId}${rest}${qs ? `?${qs}` : ""}`;
}

export function sessionAccess(store: SessionStore): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const sessionId = c.req.param("sessionId")!;
    const meta = await store.get(sessionId);
    if (!meta || meta.userId !== c.get("userId")) {
      return c.text("session not found", 404);
    }
    if (!meta.gatewayAddr) {
      return c.text("session has no gateway", 502);
    }
    c.set("session", meta);
    await next();
  };
}

export function proxyHttp(): Handler<ProxyEnv> {
  return async (c) => {
    const meta = c.get("session");
    const url = upstreamUrl(
      "http",
      meta.gatewayAddr,
      meta.id,
      proxyRest(c.req.path, meta.id),
      new URL(c.req.url).search,
    );

    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Opencode-Directory", meta.directory);
    headers.set("Authorization", `Bearer ${c.get("token")}`);
    headers.delete("host");
    // The browser origin (e.g. capacitor://localhost) means nothing to opencode's own CORS check.
    headers.delete("origin");

    const upstream = await fetch(url, {
      method: c.req.method,
      headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      redirect: "manual",
    });

    // Drop opencode's CORS headers; web's CORS middleware owns them.
    const out = new Headers(upstream.headers);
    for (const name of [...out.keys()]) {
      if (name.startsWith("access-control-")) out.delete(name);
    }
    // Bun closes connections idle for 10s, which would cut SSE streams between heartbeats.
    if (out.get("content-type")?.startsWith("text/event-stream")) {
      c.env?.timeout?.(c.req.raw, 0);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
