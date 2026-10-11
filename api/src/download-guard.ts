import type { MiddlewareHandler } from "hono";
import { bodyRuleGuard, isObject, type BodyRule } from "./body-guard.js";
import { argumentTokens } from "./command-arguments.js";
import { CONFIG_PATH, PERMISSION_RULES } from "./permission-rules.js";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";
import { RAW_PART_ROUTES } from "./upload-guard.js";

// The 1.x requests that return a file's contents: /file/content, the newer /api/fs/read/*, and
// /find (ripgrep text search, which returns matching lines). /find/file (names) and
// /find/symbol (LSP symbol names and locations) return no contents and stay allowed.
// Matched on the canonical path; a path that cannot be decoded counts.
export function isDownloadPath(rest: string): boolean {
  const path = canonicalPath(rest);
  if (path === null) return true;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "/file/content" || trimmed === "/find" || path.startsWith("/api/fs/read/");
}

// opencode reads a file: url with the same URL parser, which ignores case and leading spaces.
function isFileUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "file:";
  } catch {
    return false;
  }
}

// opencode 1.x's @path pattern (vendor/opencode-v1/packages/opencode/src/config/markdown.ts).
// The server turns each match in a command's text or a subtask's prompt into a file part when
// the path exists (session/prompt.ts resolvePromptParts), so any match counts. The lookbehind
// leaves addresses like user@host alone.
export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;

export function hasFileReference(text: unknown): boolean {
  return typeof text === "string" && Array.from(text.matchAll(FILE_REGEX)).some((match) => match[1]);
}

// A command's arguments go into its template before the @paths are read, so the template can
// complete a reference: arguments that end in "@" (or a $1..$n token that does, $1$2) followed
// by template text. A template that writes "@" before a placeholder still reads a path from
// plain arguments (README).
export function mayReferenceFile(text: unknown): boolean {
  if (typeof text !== "string") return false;
  if (hasFileReference(text) || text.endsWith("@")) return true;
  return argumentTokens(text).some((token) => token.endsWith("@"));
}

// opencode replaces {file:path} in a config's text with the file's contents when it loads it
// (vendor/opencode-v1/packages/opencode/src/config/variable.ts substitute), and GET /config
// returns them. Keys count too: the substitution runs on the text. Matched ignoring case,
// which is broader than opencode's /\{file:[^}]+\}/g.
export function hasFileToken(value: unknown): boolean {
  if (typeof value === "string") return value.toLowerCase().includes("{file:");
  if (Array.isArray(value)) return value.some(hasFileToken);
  if (isObject(value)) return Object.entries(value).some(([key, item]) => hasFileToken(key) || hasFileToken(item));
  return false;
}

// A prompt part that makes opencode read a file into the session: a file part with a file: url
// (the server reads it with bypassCwdCheck and decides itself whether it is a directory, so the
// mime is not trusted), or a subtask whose prompt references a path. MCP resource parts are
// read from their MCP server by URI, not from the part's url.
export function isFileReadPart(part: unknown): boolean {
  if (!isObject(part)) return false;
  if (part.type === "subtask") return hasFileReference(part.prompt);
  if (part.type !== "file") return false;
  if (isObject(part.source) && part.source.type === "resource") return false;
  return isFileUrl(part.url);
}

const hasFileReadPart = (body: Record<string, unknown>) => Array.isArray(body.parts) && body.parts.some(isFileReadPart);

// Paths are relative to /proxy/:sessionId, matched without a trailing slash and ignoring case.
const RULES: BodyRule[] = [
  {
    method: "POST",
    path: /^\/session\/[^/]+\/(message|prompt_async)$/i,
    denies: hasFileReadPart,
  },
  {
    // The arguments are added to the command's template, whose @paths the server reads.
    method: "POST",
    path: /^\/session\/[^/]+\/command$/i,
    denies: (body) => hasFileReadPart(body) || mayReferenceFile(body.arguments),
  },
  {
    method: "POST",
    path: /^\/api\/session\/[^/]+\/prompt$/i,
    // 1.18 nests the files in prompt; 2.x sends them at the top level. Check both.
    denies: (body) =>
      [body.files, isObject(body.prompt) ? body.prompt.files : undefined].some(
        (list) => Array.isArray(list) && list.some((file) => isObject(file) && isFileUrl(file.uri)),
      ),
  },
  {
    // instructions: files loaded into the model's context.
    method: "PATCH",
    path: CONFIG_PATH,
    denies: (body) => "instructions" in body || hasFileToken(body),
  },
  ...PERMISSION_RULES,
];

// The guard for disabled downloads. Reads (GET/HEAD) of file contents are blocked, and so are
// prompts that make the server read a file into the session (@mentions and file attachments
// by path), stored parts (RAW_PART_ROUTES) and the body rules above. Listing and name search
// stay allowed.
export function downloadGuard(): MiddlewareHandler<ProxyEnv> {
  const writes = bodyRuleGuard("downloads", "file downloads are disabled", RULES, RAW_PART_ROUTES);
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return writes(c, next);
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!);
    if (isDownloadPath(rest)) {
      console.log(`downloads blocked user=${c.get("userId")} ${method} ${rest}`);
      return c.text("file downloads are disabled", 403);
    }
    await next();
  };
}
