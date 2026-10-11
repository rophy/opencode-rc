import type { MiddlewareHandler } from "hono";
import { proxyRest, type ProxyEnv } from "./proxy.js";
import { bodyError, jsonBody } from "./request-body.js";
import type { BlockedRoute } from "./block-guard.js";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface BodyRule extends BlockedRoute {
  /** True when the JSON object body must be refused. */
  denies: (body: Record<string, unknown>) => boolean;
}

// A 1.x guard that refuses the blocked routes outright and the requests whose JSON body a
// matching rule denies (every matching rule is checked). Matched bodies are buffered and the
// proxy forwards those same bytes; a body that is not a JSON object is left to opencode's
// schema. Writes reach a guard only with a plain path (v1Guards checks).
export function bodyRuleGuard(label: string, message: string, rules: BodyRule[], blocked: BlockedRoute[] = []): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!).replace(/\/+$/, "");
    const deny = () => {
      console.log(`${label} blocked user=${c.get("userId")} ${method} ${rest}`);
      return c.text(message, 403);
    };
    if (blocked.some((b) => b.method === method && b.path.test(rest))) return deny();
    const matched = rules.filter((r) => r.method === method && r.path.test(rest));
    if (matched.length === 0) return next();
    const body = await jsonBody(c);
    if (typeof body === "string") return bodyError(c, body);
    const json = body.json;
    if (isObject(json) && matched.some((r) => r.denies(json))) return deny();
    await next();
  };
}
