import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Handler } from "hono";

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
