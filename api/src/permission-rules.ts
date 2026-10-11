import type { BodyRule } from "./body-guard.js";

// PATCH /config (the project's config.json) and PATCH /global/config take a whole opencode
// config (vendor/opencode-v1/packages/core/src/v1/config/config.ts). The UI sends only
// provider settings and the shell (context/server-sync.tsx updateConfig).
export const CONFIG_PATH = /^\/(global\/)?config$/i;

// Requests that set permission rules, refused while downloads or shell is disabled: session
// rules and config rules are evaluated after the machine owner's and the last match wins, so
// they can allow reading files or running commands that the owner's config denies. Agents and
// modes carry their own permission rules, and the deprecated tools field becomes rules too: in
// the config (config/config.ts), and on a prompt, where it replaces the session's rules
// (session/prompt.ts prompt; a command takes no tools). Neither UI sends these (auto-approve
// answers each request from the browser).
export const PERMISSION_RULES: BodyRule[] = [
  { method: "PATCH", path: CONFIG_PATH, denies: (body) => ["permission", "agent", "mode", "tools"].some((key) => key in body) },
  { method: "POST", path: /^\/session$/i, denies: (body) => "permission" in body },
  { method: "PATCH", path: /^\/session\/[^/]+$/i, denies: (body) => "permission" in body },
  { method: "POST", path: /^\/session\/[^/]+\/(message|prompt_async)$/i, denies: (body) => "tools" in body },
];
