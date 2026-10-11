import type { MiddlewareHandler } from "hono";
import { bodyRuleGuard, type BodyRule } from "./body-guard.js";
import { CONFIG_PATH } from "./permission-rules.js";
import type { ProxyEnv } from "./proxy.js";

// opencode 1.x routes that change its config (vendor/opencode-v1/packages/opencode/src/server/
// routes/instance/httpapi/groups): the project's config.json, the global config, and adding an MCP
// server (mcp.ts add; there is no route that removes one). Config can run code on the dev machine
// (provider.*.npm is installed and imported) and expose its environment ({env:VAR}, returned by
// GET /config).
const BLOCKED = [
  { method: "PATCH", path: CONFIG_PATH },
  { method: "POST", path: /^\/mcp$/i },
];

const RULES: BodyRule[] = [
  // Project commands are stored with the project (project.ts update). Name and icon edits pass.
  { method: "PATCH", path: /^\/project\/[^/]+$/i, denies: (body) => "commands" in body },
  // A "wellknown" credential makes opencode load a remote config from <providerID>/.well-known/opencode
  // on every config load (config/config.ts). API keys and OAuth tokens pass.
  { method: "PUT", path: /^\/auth\/[^/]+$/i, denies: (body) => body.type === "wellknown" },
];

// The 1.x guard for disabled config changes. Reading the config, signing in to a provider and
// choosing a model stay allowed.
export function configGuard(): MiddlewareHandler<ProxyEnv> {
  return bodyRuleGuard("config", "config changes are disabled", RULES, BLOCKED);
}
