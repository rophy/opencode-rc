import type { Context, MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import { FEATURES, type FeatureName, type RcConfig } from "../../config/schema.js";
import type { ProxyEnv } from "./proxy.js";
import { blockGuard } from "./block-guard.js";
import { downloadGuard } from "./download-guard.js";
import { shellCommandGuard } from "./shell-guard.js";
import { terminalGuard } from "./terminal-guard.js";
import { uploadGuard } from "./upload-guard.js";
import { v1ApiGuard } from "./v1-routes.js";

type Guard = MiddlewareHandler<ProxyEnv>;

// The API's runtime guard for each opencode 1.x feature, run on /proxy/* of 1.x sessions while
// the feature is disabled (2.x sessions have their own toggles and guard: v2-guard.ts).
// This is the enforcement; the UI build only removes the feature from the app
// (vendor/patches/v1/<name>/). null: the feature only changes the UI and there is nothing for
// the API to enforce. Adding a feature to config/schema.ts makes this table incomplete
// until it has an entry.
export const FEATURE_GUARDS: Record<FeatureName, Guard | null> = {
  uploads: uploadGuard(),
  // Reading a file's contents, directly or through a prompt that references it. Listing and
  // finding files stay allowed.
  downloads: downloadGuard(),
  terminal: terminalGuard(),
  // Shell mode: one command at a time, run on the dev machine and kept in the session. Also
  // shell interpolation (!`cmd`) in a command's arguments, which opencode runs the same way.
  shell: every(
    blockGuard("shell", "shell commands are disabled", [{ method: "POST", path: /^\/session\/[^/]+\/shell$/i }]),
    shellCommandGuard(),
  ),
  // Built in the browser from data the UI already loads, so there is nothing to enforce.
  export: null,
  // Publishing a session through opencode's share service. Unsharing stays allowed.
  share: blockGuard("share", "sharing is disabled", [{ method: "POST", path: /^\/session\/[^/]+\/share$/i }]),
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
// something must have a plain path. reject builds the response, so each guard set keeps its
// own error shape.
export function plainPathGuard(reject: (c: Context<ProxyEnv>) => Response): Guard {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      const path = rawPath(c.req.raw.url);
      if (path === null || !isPlainPath(path)) {
        console.log(`feature guard: blocked user=${c.get("userId")} ${method} unsupported path characters`);
        return reject(c);
      }
    }
    await next();
  };
}

export const plainPath: Guard = plainPathGuard((c) => c.text("unsupported characters in path", 400));

// The guard set for opencode 1.x sessions: the /api route check plus the guards of the
// features the config disables (FEATURES order). Always active, so writes need plain paths.
export function v1Guards(config: RcConfig, guards: Record<FeatureName, Guard | null> = FEATURE_GUARDS): Guard {
  const active = FEATURES.filter((name) => !config.features[name].enabled)
    .map((name) => guards[name])
    .filter((guard): guard is Guard => guard !== null);
  return every(plainPath, v1ApiGuard(), ...active);
}
