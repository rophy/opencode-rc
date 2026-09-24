import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

export const APP_ORIGINS: readonly string[] = ["capacitor://localhost", "https://localhost"];

// URL.origin is "null" for non-special schemes like capacitor:, so build it by hand.
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.host) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function makeOriginCheck(serverOrigin: string | null, extra: string[]) {
  const allowed = new Set<string>(APP_ORIGINS);
  for (const o of extra) {
    const trimmed = o.trim().replace(/\/+$/, "");
    if (trimmed) allowed.add(trimmed);
  }
  if (serverOrigin) allowed.add(serverOrigin);
  return (origin: string | null | undefined): boolean => !!origin && allowed.has(origin);
}

export function validateReturnTo(
  returnTo: string | undefined,
  isAllowed: (origin: string) => boolean,
): string | null {
  if (!returnTo) return "/";
  const withoutFragment = returnTo.split("#")[0];
  if (withoutFragment.startsWith("/")) {
    const second = withoutFragment[1];
    if (second === "/" || second === "\\") return null;
    return withoutFragment;
  }
  const origin = originOf(withoutFragment);
  if (!origin || !isAllowed(origin)) return null;
  return withoutFragment;
}

export function corsMiddleware(isAllowed: (origin: string) => boolean): MiddlewareHandler {
  return cors({
    origin: (origin) => (isAllowed(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // allowHeaders omitted: hono reflects Access-Control-Request-Headers,
    // which covers Authorization, Content-Type and opencode's x-opencode-* headers.
    maxAge: 600,
  });
}
