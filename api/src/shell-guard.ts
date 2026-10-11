import type { MiddlewareHandler } from "hono";
import { bodyRuleGuard, isObject, type BodyRule } from "./body-guard.js";
import { argumentTokens } from "./command-arguments.js";
import { CONFIG_PATH, PERMISSION_RULES } from "./permission-rules.js";
import type { ProxyEnv } from "./proxy.js";

// opencode runs each !`cmd` in a command's text as a shell command on the dev machine, after
// putting the user's arguments into the command's template: SHELL_REGEX /!`([^`]+)`/g in
// 1.x (vendor/opencode-v1/packages/opencode/src/config/markdown.ts, used by session/prompt.ts
// command) and the same shellRegex in 2.x (vendor/opencode-v2/packages/core/src/config/plugin/
// command.ts evaluateTemplate). The template's text around a placeholder can complete a
// match: it can supply the closing backtick (so an unclosed "!`" counts) or a backtick after
// arguments that end in "!" (review.txt has $ARGUMENTS`). Quote trimming of $1..$n can also
// join "!" and "`" from two tokens ($1$2). So the arguments are refused when they contain
// "!`", end in "!", or a token ends in "!". A template that writes "!" before a placeholder,
// or puts one inside its own !`…`, still runs plain arguments in a shell (README).
export function mayRunShell(text: unknown): boolean {
  if (typeof text !== "string") return false;
  if (text.includes("!`") || text.endsWith("!")) return true;
  return argumentTokens(text).some((token) => token.endsWith("!"));
}

const nonBlank = (value: unknown) => typeof value === "string" && value.trim() !== "";

// Config fields whose values the server runs or loads as code: command templates (their !`cmd`
// runs), MCP servers and their commands, the shell binary, plugins, formatter and LSP commands
// (vendor/opencode-v1/packages/core/src/v1/config/config.ts).
const SHELL_CONFIG_KEYS = ["command", "mcp", "shell", "plugin", "formatter", "lsp"];

const RULES: BodyRule[] = [
  { method: "POST", path: /^\/session\/[^/]+\/command$/i, denies: (body) => mayRunShell(body.arguments) },
  // Run with bash -lc in the new worktree (worktree/index.ts runStartCommand).
  { method: "POST", path: /^\/experimental\/worktree$/i, denies: (body) => nonBlank(body.startCommand) },
  // Stored and run on every worktree create and reset. The UI sends commands.start with each
  // project edit; blank runs nothing (runStartScript), and the shell patch omits it.
  { method: "PATCH", path: /^\/project\/[^/]+$/i, denies: (body) => isObject(body.commands) && nonBlank(body.commands.start) },
  { method: "PATCH", path: CONFIG_PATH, denies: (body) => SHELL_CONFIG_KEYS.some((key) => key in body) },
  ...PERMISSION_RULES,
];

// The 1.x guard for disabled shell commands: shell mode, adding an MCP server (POST /mcp, which
// starts it; the UI only connects configured ones), and the body rules above.
export function shellGuard(): MiddlewareHandler<ProxyEnv> {
  return bodyRuleGuard("shell", "shell commands are disabled", RULES, [
    { method: "POST", path: /^\/session\/[^/]+\/shell$/i },
    { method: "POST", path: /^\/mcp$/i },
  ]);
}
