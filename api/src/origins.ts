import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

export const APP_ORIGINS: readonly string[] = ["opencode-rc://localhost", "https://localhost"];

// The mobile apps' sign-in redirect URI (RFC 8252 private-use scheme), registered at the IdP for
// the apps' public client. The system browser view hands it to the app.
export const APP_REDIRECT_URI = "com.opencode.rc:/auth/callback";

// URL.origin is "null" for non-special schemes like opencode-rc:, so build it by hand.
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

const PATH_BASE = "https://placeholder.invalid";

// Browsers strip tab/newline from URLs and treat a backslash like "/", so a
// path such as "/<TAB>/evil.com" would resolve to another host. Reject them outright.
function hasUnsafeChars(value: string): boolean {
  return /[\x00-\x1f\x7f\\]/.test(value);
}

export function validateReturnTo(
  returnTo: string | undefined,
  isAllowed: (origin: string) => boolean,
): string | null {
  if (!returnTo) return "/";
  if (hasUnsafeChars(returnTo)) return null;
  const withoutFragment = returnTo.split("#")[0];
  if (withoutFragment.startsWith("/")) {
    let parsed: URL;
    try {
      parsed = new URL(withoutFragment, PATH_BASE);
    } catch {
      return null;
    }
    if (parsed.origin !== PATH_BASE) return null;
    // Dot segments can collapse "/.//evil.com" into "//evil.com", which a browser
    // would read as another host.
    if (parsed.pathname.startsWith("//")) return null;
    return parsed.pathname + parsed.search;
  }
  const origin = originOf(withoutFragment);
  // The app signs in outside its WebView now; its WebView origins stay allowed for CORS only.
  if (!origin || APP_ORIGINS.includes(origin) || !isAllowed(origin)) return null;
  return withoutFragment;
}

export function corsMiddleware(isAllowed: (origin: string) => boolean): MiddlewareHandler {
  return cors({
    origin: (origin) => (isAllowed(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // allowHeaders omitted: hono reflects Access-Control-Request-Headers,
    // which covers Authorization, Content-Type and opencode's x-opencode-* headers.
    // Lets browser code read the server's protocol (docs/api-versioning.md).
    exposeHeaders: ["OpenCode-RC-Protocol"],
    maxAge: 600,
  });
}
