import type { MiddlewareHandler } from "hono";
import { bodyRuleGuard, isObject, type BodyRule } from "./body-guard.js";
import type { ProxyEnv } from "./proxy.js";

export const isFileUri = (value: unknown) => typeof value === "string" && value.toLowerCase().startsWith("file:");

// A file part carries uploaded bytes (data:) or a remote attachment (http(s):), unless it
// names a workspace file (file:, an @mention) or an MCP resource, which opencode reads by
// its own URI and never from the part's url.
export function isUploadPart(part: unknown): boolean {
  if (!isObject(part) || part.type !== "file") return false;
  if (isObject(part.source) && part.source.type === "resource") return false;
  return !isFileUri(part.url);
}

// Paths are relative to /proxy/:sessionId, matched without a trailing slash and ignoring
// case so a variant opencode would also route cannot slip past.
const RULES: BodyRule[] = [
  {
    method: "POST",
    path: /^\/session\/[^/]+\/(message|prompt_async|command)$/i,
    denies: (body) => Array.isArray(body.parts) && body.parts.some(isUploadPart),
  },
  {
    method: "POST",
    path: /^\/api\/session\/[^/]+\/prompt$/i,
    // 1.18 nests the files in prompt; 2.x sends them at the top level. Check both.
    denies: (body) =>
      [body.files, isObject(body.prompt) ? body.prompt.files : undefined].some(
        (list) => Array.isArray(list) && list.some((file) => !isObject(file) || !isFileUri(file.uri)),
      ),
  },
  {
    method: "PATCH",
    path: /^\/project\/[^/]+$/i,
    denies: (body) =>
      isObject(body.icon) &&
      typeof body.icon.override === "string" &&
      body.icon.override.toLowerCase().startsWith("data:"),
  },
];

// Routes that store parts as they are, past the prompt checks; the UI never calls either.
// Blocked outright by the uploads and downloads guards:
// - POST /sync/replay replays part events, which reach the model without passing through
//   any of the rules above.
// - PATCH of a part stores it as-is for the model to read later, and more than file parts
//   can carry bytes (a completed tool part's attachments are sent to the model too); a
//   stored subtask part runs, and its prompt's @paths are read (download-guard.ts).
export const RAW_PART_ROUTES: { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/sync\/replay$/i },
  { method: "PATCH", path: /^\/session\/[^/]+\/message\/[^/]+\/part\/[^/]+$/i },
];

// The guard for a disabled uploads feature (see feature-guards.ts, which also makes sure the
// path is plain): rejects requests that would send a file to opencode. Matched requests are
// buffered and checked, and the proxy forwards those same bytes; other requests stream
// through untouched.
export function uploadGuard(): MiddlewareHandler<ProxyEnv> {
  return bodyRuleGuard("upload", "uploads are disabled", RULES, RAW_PART_ROUTES);
}
