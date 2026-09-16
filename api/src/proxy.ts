import type { Context } from "hono";
import type { SessionStore } from "./store.js";
import type { AuthEnv } from "./auth.js";

export function proxyToGateway(store: SessionStore) {
  return async (c: Context<AuthEnv>) => {
    const sessionId = c.req.param("sessionId")!;
    const rest = c.req.path.replace(`/s/${sessionId}`, "") || "/";

    const meta = await store.get(sessionId);
    if (!meta) {
      return c.text("session not found", 404);
    }

    const userId = c.get("userId");
    if (userId && userId !== meta.userId) {
      return c.text("session not found", 404);
    }

    if (!meta.gatewayAddr) {
      return c.text("session has no gateway", 502);
    }

    const target = `http://${meta.gatewayAddr}/proxy/${sessionId}${rest}`;
    const url = new URL(target);
    url.search = new URL(c.req.url).search;

    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Opencode-Directory", meta.directory);
    headers.delete("host");

    const proxyRes = await fetch(url.toString(), {
      method: c.req.method,
      headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD"
        ? c.req.raw.body
        : undefined,
      redirect: "manual",
    });

    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers: proxyRes.headers,
    });
  };
}
