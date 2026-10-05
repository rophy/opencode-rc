import type { MiddlewareHandler } from "hono";
import { proxyRest, type ProxyEnv } from "./proxy.js";

export interface BlockedRoute {
  method: string;
  /** Relative to /proxy/:sessionId, matched without a trailing slash and ignoring case. */
  path: RegExp;
}

// A guard that refuses the given routes outright, whatever the body. The routes are writes,
// which reach a guard only with a plain path (featureGuards checks), so the path matched here
// is the path that would be forwarded.
export function blockGuard(label: string, message: string, routes: BlockedRoute[]): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!).replace(/\/+$/, "");
    if (routes.some((r) => r.method === c.req.method && r.path.test(rest))) {
      console.log(`${label} blocked user=${c.get("userId")} ${c.req.method} ${rest}`);
      return c.text(message, 403);
    }
    await next();
  };
}
