import type { MiddlewareHandler } from "hono";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";

// opencode's terminal API: /pty/* and, in the newer API, /api/pty/* (create, list, connect
// token and the WebSocket itself). Matched on the canonical path because the WebSocket is a
// GET, which the plain-path check does not cover; a path that cannot be decoded counts.
export function isTerminalPath(rest: string): boolean {
  const path = canonicalPath(rest);
  return path === null || /^\/(api\/)?pty(\/|$)/.test(path);
}

// The guard for a disabled terminal: refuses every terminal request, including the
// WebSocket upgrade (featureGuards runs before the relay).
export function terminalGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!);
    if (isTerminalPath(rest)) {
      console.log(`terminal blocked user=${c.get("userId")} ${c.req.method} ${rest}`);
      return c.text("the terminal is disabled", 403);
    }
    await next();
  };
}
