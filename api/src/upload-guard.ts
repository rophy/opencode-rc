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

// PATCHing a part stores it as-is for the model to read later; opencode only ignores a
// resource part's url on the prompt path, not here, so this has no resource exemption.
function isUploadPartPatch(part: unknown): boolean {
  return isObject(part) && part.type === "file" && !isFileUri(part.url);
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
    method: "PATCH",
    path: /^\/session\/[^/]+\/message\/[^/]+\/part\/[^/]+$/i,
    denies: isUploadPartPatch,
  },
  {
    method: "POST",
    path: /^\/api\/session\/[^/]+\/prompt$/i,
    denies: (body) =>
      isObject(body) &&
      isObject(body.prompt) &&
      Array.isArray(body.prompt.files) &&
      body.prompt.files.some((file) => !isObject(file) || !isFileUri(file.uri)),
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

// The UI never calls /sync/*; replaying part events this way reaches the model without
// passing through any of the rules above, so it is blocked outright, not body-checked.
const SYNC_REPLAY = /^\/sync\/replay$/i;

// With uploads disabled, rejects requests that would send a file to opencode. Matched
// requests are buffered and checked, and the proxy forwards those same bytes; other
// requests stream through untouched.
export function uploadGuard(enabled: boolean): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    if (enabled) return next();
    const rest = proxyRest(c.req.path, c.req.param("sessionId")!).replace(/\/+$/, "");

    if (c.req.method === "POST" && SYNC_REPLAY.test(rest)) {
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
