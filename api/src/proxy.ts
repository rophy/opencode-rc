import type { Handler, MiddlewareHandler } from "hono";
import type { SessionStore, SessionMeta } from "./store.js";
import type { AuthEnv } from "./auth.js";
import type { AccessWatch } from "./authz.js";

// Under Bun, Hono's env is the Bun server.
type ServerEnv = { Bindings: { timeout?: (request: Request, seconds: number) => void } | undefined };

// body: set by uploadGuard when it read the request body to check it.
export type ProxyEnv = AuthEnv & ServerEnv & { Variables: { session: SessionMeta; body: ArrayBuffer | undefined } };

export function proxyRest(path: string, sessionId: string): string {
  const rest = path.slice(`/proxy/${sessionId}`.length).replace(/\/{2,}/g, "/");
  return rest.startsWith("/") ? rest : `/${rest}`;
}

// How a path is read by the hops after the API, for guards that must match GET requests too,
// where paths are not required to be plain. The input is the path as the proxy forwards it
// (proxyRest of Hono's c.req.path, already decoded once with decodeURI). fetch and WebSocket
// parse it again as a URL without decoding more, and opencode's router decodes once, so the
// guards decode exactly once too and never drop or resolve more than that parse does:
// - a percent-encoded structural character (/ \ ? # ; . %) or control character is rejected
//   (null): the hops after the API would not decode it the way a second decode here would;
// - after the one decode, ? # ; \ and control characters are rejected (null) as well, since
//   fetch / WebSocket would split or rewrite the path at them;
// - then slashes are collapsed, literal dot segments resolved (new URL, which encodes spaces
//   and the like as fetch does) and the result lower-cased.
// null also when the path cannot be decoded.
export function canonicalPath(path: string): string | null {
  if (/%(2f|5c|3f|23|3b|2e|25|[01][0-9a-f]|7f)/i.test(path)) return null;
  let p: string;
  try {
    p = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (/[?#;\\\x00-\x1f\x7f]/.test(p)) return null;
  p = `/${p}`.replace(/\/{2,}/g, "/");
  return new URL(p, "http://x").pathname.replace(/\/{2,}/g, "/").toLowerCase();
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
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? (c.get("body") ?? c.req.raw.body) : undefined,
      redirect: "manual",
    });

    // Drop opencode's CORS headers; web's CORS middleware owns them.
    const out = new Headers(upstream.headers);
    for (const name of [...out.keys()]) {
      if (name.startsWith("access-control-")) out.delete(name);
    }
    let body: ReadableStream<Uint8Array> | null = upstream.body;
    if (out.get("content-type")?.startsWith("text/event-stream")) {
      // Bun closes connections idle for 10s, which would cut SSE streams between heartbeats.
      c.env?.timeout?.(c.req.raw, 0);
      const watch = c.get("watchAccess");
      if (body && watch) body = endOnDenial(body, watch);
    }
    return new Response(body, { status: upstream.status, headers: out });
  };
}

// The event stream, ended when a re-check of the user's access denies. The client then
// reconnects and gets the 403.
export function endOnDenial(body: ReadableStream<Uint8Array>, watch: AccessWatch): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let stop = () => {};
  let closed = false;
  const close = (ctl: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    stop();
    ctl.close();
  };
  return new ReadableStream<Uint8Array>({
    start(ctl) {
      stop = watch(() => {
        close(ctl);
        reader.cancel().catch(() => {});
      });
    },
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (done) close(ctl);
        else if (!closed) ctl.enqueue(value);
      } catch (err) {
        if (closed) return;
        closed = true;
        stop();
        ctl.error(err);
      }
    },
    cancel(reason) {
      closed = true;
      stop();
      return reader.cancel(reason);
    },
  });
}
