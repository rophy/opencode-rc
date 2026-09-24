import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Handler, MiddlewareHandler } from "hono";

export function resolveSpaFile(webUiDir: string, urlPath: string): string | null {
  const root = resolve(webUiDir);
  const index = join(root, "index.html");
  if (!existsSync(index)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return index;
  }

  const candidate = resolve(root, "." + decoded);
  if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  return index;
}

export function spaHandler(webUiDir: string): Handler {
  return (c) => {
    const file = resolveSpaFile(webUiDir, c.req.path);
    if (!file) return c.text("web UI not configured", 404);
    return new Response(Bun.file(file));
  };
}

const RESERVED_PREFIXES = ["/api", "/auth", "/gateway", "/proxy"];

export function isReservedPath(path: string): boolean {
  return RESERVED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

// Unknown API paths get a JSON 404 instead of the SPA's index.html.
export function reservedNotFound(): MiddlewareHandler {
  return async (c, next) => {
    if (isReservedPath(c.req.path)) return c.json({ error: "not found" }, 404);
    await next();
  };
}
