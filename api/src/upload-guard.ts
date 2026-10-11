import type { MiddlewareHandler } from "hono";
import { proxyRest, type ProxyEnv } from "./proxy.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFileUri = (value: unknown) => typeof value === "string" && value.toLowerCase().startsWith("file:");

// A file part carries uploaded bytes (data:) or a remote attachment (http(s):), unless it
// names a workspace file (file:, an @mention) or an MCP resource, which opencode reads by
// its own URI and never from the part's url.
export function isUploadPart(part: unknown): boolean {
  if (!isObject(part) || part.type !== "file") return false;
  if (isObject(part.source) && part.source.type === "resource") return false;
  return !isFileUri(part.url);
}

interface Rule {
  method: string;
  path: RegExp;
  denies: (body: unknown) => boolean;
}

// Paths are relative to /proxy/:sessionId, matched without a trailing slash and ignoring
// case so a variant opencode would also route cannot slip past.
const RULES: Rule[] = [
  {
    method: "POST",
    path: /^\/session\/[^/]+\/(message|prompt_async|command)$/i,
    denies: (body) => isObject(body) && Array.isArray(body.parts) && body.parts.some(isUploadPart),
  },
  {
    method: "POST",
    path: /^\/api\/session\/[^/]+\/prompt$/i,
    // 1.18 nests the files in prompt; 2.x sends them at the top level. Check both.
    denies: (body) =>
      isObject(body) &&
      [body.files, isObject(body.prompt) ? body.prompt.files : undefined].some(
        (list) => Array.isArray(list) && list.some((file) => !isObject(file) || !isFileUri(file.uri)),
      ),
  },
  {
    method: "PATCH",
    path: /^\/project\/[^/]+$/i,
    denies: (body) =>
      isObject(body) &&
      isObject(body.icon) &&
      typeof body.icon.override === "string" &&
      body.icon.override.toLowerCase().startsWith("data:"),
  },
];

// Blocked outright, not body-checked. The UI never calls either:
// - POST /sync/replay replays part events, which reach the model without passing through
//   any of the rules above.
// - PATCH of a part stores it as-is for the model to read later, and more than file parts
//   can carry bytes (a completed tool part's attachments are sent to the model too).
const BLOCKED: { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/sync\/replay$/i },
  { method: "PATCH", path: /^\/session\/[^/]+\/message\/[^/]+\/part\/[^/]+$/i },
];

// The guard for a disabled uploads feature (see feature-guards.ts, which also makes sure the
// path is plain): rejects requests that would send a file to opencode. Matched requests are
// buffered and checked, and the proxy forwards those same bytes; other requests stream
// through untouched.
export function uploadGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!).replace(/\/+$/, "");

    if (BLOCKED.some((b) => b.method === method && b.path.test(rest))) {
      console.log(`upload blocked user=${c.get("userId")} ${c.req.method} ${rest}`);
      return c.text("uploads are disabled", 403);
    }

    const rule = RULES.find((r) => r.method === c.req.method && r.path.test(rest));
    if (!rule) return next();

    const body = await c.req.raw.arrayBuffer();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return c.text("request body is not JSON", 400);
    }
    if (rule.denies(parsed)) {
      console.log(`upload blocked user=${c.get("userId")} ${c.req.method} ${rest}`);
      return c.text("uploads are disabled", 403);
    }
    c.set("body", body);
    await next();
  };
}
