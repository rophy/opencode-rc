import type { MiddlewareHandler } from "hono";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";
import { templateRegex } from "./route-template.js";
import { V2_ROUTES } from "./v2-routes.js";

// The /api routes opencode 1.x serves (vendor/opencode-v1, packages/protocol). Its legacy
// routes (/session, /pty, ...) are not listed: those pass through the v1 feature guards as
// before. v1-routes.test.ts keeps this list equal to the submodule's.
export const V1_API_ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/api/agent"],
  ["GET", "/api/command"],
  ["DELETE", "/api/credential/:credentialID"],
  ["PATCH", "/api/credential/:credentialID"],
  ["GET", "/api/event"],
  ["GET", "/api/fs/find"],
  ["GET", "/api/fs/list"],
  ["GET", "/api/fs/read/*"],
  ["GET", "/api/health"],
  ["GET", "/api/integration"],
  ["GET", "/api/integration/:integrationID"],
  ["POST", "/api/integration/:integrationID/connect/key"],
  ["POST", "/api/integration/:integrationID/connect/oauth"],
  ["DELETE", "/api/integration/attempt/:attemptID"],
  ["GET", "/api/integration/attempt/:attemptID"],
  ["POST", "/api/integration/attempt/:attemptID/complete"],
  ["GET", "/api/location"],
  ["GET", "/api/model"],
  ["GET", "/api/permission/request"],
  ["GET", "/api/permission/saved"],
  ["DELETE", "/api/permission/saved/:id"],
  ["GET", "/api/provider"],
  ["GET", "/api/provider/:providerID"],
  ["GET", "/api/pty"],
  ["POST", "/api/pty"],
  ["DELETE", "/api/pty/:ptyID"],
  ["GET", "/api/pty/:ptyID"],
  ["PUT", "/api/pty/:ptyID"],
  ["GET", "/api/pty/:ptyID/connect"],
  ["POST", "/api/pty/:ptyID/connect-token"],
  ["GET", "/api/question/request"],
  ["GET", "/api/reference"],
  ["GET", "/api/session"],
  ["POST", "/api/session"],
  ["GET", "/api/session/:sessionID"],
  ["POST", "/api/session/:sessionID/agent"],
  ["POST", "/api/session/:sessionID/compact"],
  ["GET", "/api/session/:sessionID/context"],
  ["GET", "/api/session/:sessionID/event"],
  ["GET", "/api/session/:sessionID/history"],
  ["POST", "/api/session/:sessionID/interrupt"],
  ["GET", "/api/session/:sessionID/message"],
  ["GET", "/api/session/:sessionID/message/:messageID"],
  ["POST", "/api/session/:sessionID/model"],
  ["GET", "/api/session/:sessionID/permission"],
  ["POST", "/api/session/:sessionID/permission"],
  ["GET", "/api/session/:sessionID/permission/:requestID"],
  ["POST", "/api/session/:sessionID/permission/:requestID/reply"],
  ["POST", "/api/session/:sessionID/prompt"],
  ["GET", "/api/session/:sessionID/question"],
  ["POST", "/api/session/:sessionID/question/:requestID/reject"],
  ["POST", "/api/session/:sessionID/question/:requestID/reply"],
  ["POST", "/api/session/:sessionID/revert/clear"],
  ["POST", "/api/session/:sessionID/revert/commit"],
  ["POST", "/api/session/:sessionID/revert/stage"],
  ["POST", "/api/session/:sessionID/wait"],
  ["GET", "/api/session/active"],
  ["GET", "/api/skill"],
];

const V1_API = V1_API_ROUTES.map(([method, path]) => ({ method, re: templateRegex(path) }));
// 2.x routes outside /api (in practice GET /auth/connect/:code, which mints opencode logins).
// 1.x has no table for non-/api paths, so these are refused on a 1.x session. No legacy 1.x
// path matches them; v1-routes.test.ts pins the list.
const V2_ONLY_NON_API = V2_ROUTES.filter(([, path]) => !path.startsWith("/api/")).map(([method, path]) => ({ method, re: templateRegex(path) }));

// A 1.x session may use only the /api routes 1.x has. A session that reports 1.x but runs
// something else (a modified CLI) then cannot reach routes only 2.x has, such as
// POST /api/experimental/fs/write or POST /api/shell.
export function v1ApiGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!);
    const path = canonicalPath(rest);
    if (path === null) {
      console.log(`v1 guard: blocked user=${c.get("userId")} ${c.req.method} undecodable path`);
      return c.text("unsupported characters in path", 400);
    }
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (path !== "/api" && !path.startsWith("/api/")) {
      const bare = path.replace(/\/+$/, "");
      if (!V2_ONLY_NON_API.some((r) => r.method === method && r.re.test(bare))) return next();
      console.log(`v1 guard: blocked user=${c.get("userId")} ${c.req.method} ${path}`);
      return c.text("this opencode route is not available through opencode-rc", 403);
    }
    if (method === "OPTIONS" || V1_API.some((r) => r.method === method && r.re.test(path.replace(/\/+$/, "")))) {
      return next();
    }
    console.log(`v1 guard: blocked user=${c.get("userId")} ${c.req.method} ${path}`);
    return c.text("this opencode route is not available through opencode-rc", 403);
  };
}
