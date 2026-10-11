import type { MiddlewareHandler } from "hono";
import { proxyRest, type ProxyEnv } from "./proxy.js";
import { jsonBody } from "./request-body.js";

// opencode runs each !`cmd` in a command's text as a shell command on the dev machine, after
// putting the user's arguments into the command's template: SHELL_REGEX /!`([^`]+)`/g in
// 1.x (vendor/opencode-v1/packages/opencode/src/config/markdown.ts, used by session/prompt.ts
// command) and the same shellRegex in 2.x (vendor/opencode-v2/packages/core/src/config/plugin/
// command.ts evaluateTemplate). The template's own text can supply the closing backtick, so
// any "!`" in the user's text counts, closed or not. A lone "!" or `code` without "!" passes.
export function hasShellInterpolation(text: unknown): boolean {
  return typeof text === "string" && text.includes("!`");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The 1.x guard for command requests while shell commands are disabled. The arguments are the
// only user text 1.x interpolates (1.18 has no /api command route).
export function shellCommandGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!).replace(/\/+$/, "");
    if (c.req.method !== "POST" || !/^\/session\/[^/]+\/command$/i.test(rest)) return next();
    const body = await jsonBody(c);
    if (!body) return c.text("request body is not JSON", 400);
    if (isObject(body.json) && hasShellInterpolation(body.json.arguments)) {
      console.log(`shell blocked user=${c.get("userId")} ${c.req.method} ${rest}`);
      return c.text("shell commands are disabled", 403);
    }
    await next();
  };
}
