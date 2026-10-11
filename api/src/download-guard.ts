import type { MiddlewareHandler } from "hono";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";

// The 1.x requests that return a file's contents: /file/content, the newer /api/fs/read/*, and
// /find (ripgrep text search, which returns matching lines). /find/file (names) and
// /find/symbol (LSP symbol names and locations) return no contents and stay allowed.
// Matched on the canonical path; a path that cannot be decoded counts.
export function isDownloadPath(rest: string): boolean {
  const path = canonicalPath(rest);
  if (path === null) return true;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "/file/content" || trimmed === "/find" || path.startsWith("/api/fs/read/");
}

// The guard for disabled downloads. Only reads (GET/HEAD) return contents; other methods are
// left to the other guards. Listing and name search stay allowed.
export function downloadGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") {
      const rest = proxyRest(c.req.path, c.req.param("sessionId")!);
      if (isDownloadPath(rest)) {
        console.log(`downloads blocked user=${c.get("userId")} ${method} ${rest}`);
        return c.text("file downloads are disabled", 403);
      }
    }
    await next();
  };
}
