import type { MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import { FEATURES, type FeatureName, type RcConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { uploadGuard } from "./upload-guard.js";

type Guard = MiddlewareHandler<ProxyEnv>;

// The API's runtime guard for each feature, run on /proxy/* while the feature is disabled.
// This is the enforcement; the UI build only removes the feature from the app
// (vendor/patches/<name>/). null: the feature only changes the UI and there is nothing for
// the API to enforce. Adding a feature to config/schema.ts makes this table incomplete
// until it has an entry.
export const FEATURE_GUARDS: Record<FeatureName, Guard | null> = {
  uploads: uploadGuard(),
};

// Hono matches on a decoded path, while fetch, the gateway, the CLI and opencode's router
// each parse the path again: '\' becomes '/', tabs and newlines are dropped, trailing
// spaces are trimmed, encodings are decoded, ';' '?' '#' cut it short, and dot segments
// are resolved. A path made only of these characters, with no "." or ".." segment, looks
// the same at every hop, so the guards check exactly the path that is forwarded.
const PLAIN_PATH = /^[A-Za-z0-9/_.~-]*$/;

export function isPlainPath(path: string): boolean {
  return PLAIN_PATH.test(path) && !path.split("/").some((seg) => seg === "." || seg === "..");
}

// The undecoded path of the request url, or null when it cannot be parsed (Bun leaves the
// url relative when the Host header is malformed).
export function rawPath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// Guards match request paths, so while any guard is active a request that may change
// something must have a plain path.
export const plainPath: Guard = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    const path = rawPath(c.req.raw.url);
    if (path === null || !isPlainPath(path)) {
      console.log(`feature guard: blocked user=${c.get("userId")} ${method} unsupported path characters`);
      return c.text("unsupported characters in path", 400);
    }
  }
  await next();
};

// The guards of the features the config disables, in FEATURES order; a pass-through when
// none of them has one.
export function featureGuards(config: RcConfig, guards: Record<FeatureName, Guard | null> = FEATURE_GUARDS): Guard {
  const active = FEATURES.filter((name) => !config.features[name].enabled)
    .map((name) => guards[name])
    .filter((guard): guard is Guard => guard !== null);
  if (active.length === 0) return (_c, next) => next();
  return every(plainPath, ...active);
}
