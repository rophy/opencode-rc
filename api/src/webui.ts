import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "hono";
import type { SessionStore } from "./store.js";
import type { AuthEnv } from "./auth.js";

export function sessionHandler(store: SessionStore, webUiDir: string) {
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

    if (webUiDir && (rest === "/" || isStaticAsset(webUiDir, rest))) {
      return serveStatic(webUiDir, rest);
    }

    // Proxy to gateway
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

function isStaticAsset(webUiDir: string, subpath: string): boolean {
  const filePath = join(resolve(webUiDir), subpath.replace(/^\//, ""));
  return existsSync(filePath);
}

function serveStatic(webUiDir: string, subpath: string): Response {
  let filePath: string;
  if (subpath === "/" || subpath === "/index.html") {
    filePath = join(resolve(webUiDir), "index.html");
  } else {
    filePath = join(resolve(webUiDir), subpath.replace(/^\//, ""));
    if (!existsSync(filePath)) {
      filePath = join(resolve(webUiDir), "index.html");
    }
  }

  const file = Bun.file(filePath);
  return new Response(file);
}

export function serveStaticFile(webUiDir: string, urlPath: string): Response {
  const filePath = join(resolve(webUiDir), urlPath.replace(/^\//, ""));
  if (!existsSync(filePath)) {
    return new Response("not found", { status: 404 });
  }
  return new Response(Bun.file(filePath));
}

export function rootWebUiHandler(webUiDir: string) {
  return (c: Context<AuthEnv>) => {
    const filePath = join(resolve(webUiDir), "index.html");
    if (!existsSync(filePath)) {
      return c.text("web UI not configured", 404);
    }
    return new Response(Bun.file(filePath));
  };
}
