import type { MiddlewareHandler } from "hono";
import type { RcConfig } from "../../config/schema.js";
import { v1Guards } from "./feature-guards.js";
import type { ProxyEnv } from "./proxy.js";
import { v2Guards } from "./v2-guard.js";

type Guard = MiddlewareHandler<ProxyEnv>;

// Sessions registered by CLIs that predate version reporting have no version; they ran 1.x.
export function isV1Session(version: string | undefined): boolean {
  return !version || /^1\./.test(version);
}

// The guard set for the session's opencode version (sessionAccess sets the session). The
// version comes from the gateway's record, never from the browser.
export function versionedGuards(config: RcConfig): Guard {
  const v1 = v1Guards(config);
  const v2 = v2Guards(config);
  return (c, next) => (isV1Session(c.get("session").opencodeVersion) ? v1 : v2)(c, next);
}
