import type { MiddlewareHandler } from "hono";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";
import { jsonBody } from "./request-body.js";

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

// Paths are relative to /proxy/:sessionId, matched without a trailing slash and ignoring case,
// as in upload-guard.ts.
const RULES: { path: RegExp; denies: (body: Record<string, unknown>) => boolean }[] = [
  {
    path: /^\/session\/[^/]+\/(message|prompt_async)$/i,
    denies: hasFileReadPart,
  },
  {
    // The arguments are added to the command's template, whose @paths the server reads.
    path: /^\/session\/[^/]+\/command$/i,
    denies: (body) => hasFileReadPart(body) || hasFileReference(body.arguments),
  },
  {
    path: /^\/api\/session\/[^/]+\/prompt$/i,
    // 1.18 nests the files in prompt; 2.x sends them at the top level. Check both.
    denies: (body) =>
      [body.files, isObject(body.prompt) ? body.prompt.files : undefined].some(
        (list) => Array.isArray(list) && list.some((file) => isObject(file) && isFileUrl(file.uri)),
      ),
  },
];

// The guard for disabled downloads. Reads (GET/HEAD) of file contents are blocked, and so are
// prompts that make the server read a file into the session (@mentions and file
// attachments by path). Listing and name search stay allowed.
export function downloadGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!);
    if (method === "GET" || method === "HEAD") {
      if (isDownloadPath(rest)) {
        console.log(`downloads blocked user=${c.get("userId")} ${method} ${rest}`);
        return c.text("file downloads are disabled", 403);
      }
      return next();
    }
    const trimmed = rest.replace(/\/+$/, "");
    const rule = method === "POST" ? RULES.find((r) => r.path.test(trimmed)) : undefined;
    if (!rule) return next();
    const body = await jsonBody(c);
    if (!body) return c.text("request body is not JSON", 400);
    if (isObject(body.json) && rule.denies(body.json)) {
      console.log(`downloads blocked user=${c.get("userId")} ${method} ${trimmed}`);
      return c.text("file downloads are disabled", 403);
    }
    await next();
  };
}
