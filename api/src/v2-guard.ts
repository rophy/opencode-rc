import type { Context, MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import type { FeatureNameV2, RcConfig } from "../../config/schema.js";
import { plainPathGuard } from "./feature-guards.js";
import { canonicalPath, proxyRest, upstreamUrl, type ProxyEnv } from "./proxy.js";
import { jsonBody } from "./request-body.js";
import { hasShellInterpolation } from "./shell-guard.js";
import { templateRegex } from "./route-template.js";
import { V2_ROUTES } from "./v2-routes.js";

type Guard = MiddlewareHandler<ProxyEnv>;
type Features = RcConfig["opencodeV2"]["features"];
type ServerInfo = { paths?: { tmp?: unknown } };

const ROUTES = V2_ROUTES.map(([method, template, rule]) => ({ method, template, rule, re: templateRegex(template) }));

const MESSAGES: Record<FeatureNameV2, string> = {
  uploads: "uploads are disabled",
  downloads: "file downloads are disabled",
  terminal: "the terminal is disabled",
  shell: "shell commands are disabled",
  export: "export is disabled",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFileUri = (v: unknown) => typeof v === "string" && v.toLowerCase().startsWith("file:");

// 400 with the error shape opencode 2.x's client shows to the user ({_tag, message}); a 401
// would switch the app to its connect screen and a 403 shows as "UnexpectedStatus: 403".
function reject(c: Context<ProxyEnv>, message: string, detail: string) {
  console.log(`v2 guard: blocked user=${c.get("userId")} ${detail}`);
  return c.json({ _tag: "FeatureDisabled", message }, 400);
}

// GET /api/info on the dev machine, through the gateway like any proxied request.
async function defaultFetchServerInfo(c: Context<ProxyEnv>): Promise<ServerInfo> {
  const meta = c.get("session");
  const res = await fetch(upstreamUrl("http", meta.gatewayAddr, meta.id, "/api/info", ""), {
    headers: { Authorization: `Bearer ${c.get("token")}`, "X-Opencode-Directory": meta.directory },
  });
  if (!res.ok) throw new Error(`GET /api/info: ${res.status}`);
  return (await res.json()) as ServerInfo;
}


// Reads and parses a JSON object body; the proxy forwards exactly the bytes checked.
async function readJson(c: Context<ProxyEnv>): Promise<Record<string, unknown> | string> {
  const body = await jsonBody(c);
  if (!body) return "request body is not JSON";
  if (!isObject(body.json)) return "request body is not a JSON object";
  return body.json;
}

async function checkFsWrite(
  c: Context<ProxyEnv>,
  fetchServerInfo: (c: Context<ProxyEnv>) => Promise<ServerInfo>,
): Promise<string | null> {
  const denied = "uploads may only be written to the uploads folder";
  const path = new URL(c.req.url).searchParams.get("path");
  if (!path || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) return denied;
  let tmp: unknown;
  try {
    tmp = (await fetchServerInfo(c)).paths?.tmp;
  } catch {
    return denied;
  }
  if (typeof tmp !== "string") return denied;
  const base = tmp.replace(/\/$/, "");
  if (base === "") return denied;
  return path.startsWith(`${base}/uploads/`) ? null : denied;
}

// Body and query checks for allowed routes, keyed by route template. Returns the rejection
// message, or null to forward.
async function checkRequest(
  c: Context<ProxyEnv>,
  template: string,
  features: Features,
  fetchServerInfo: (c: Context<ProxyEnv>) => Promise<ServerInfo>,
): Promise<string | null> {
  const uploadsOff = !features.uploads.enabled;
  if (template === "/api/experimental/fs/write") return checkFsWrite(c, fetchServerInfo);
  if (template === "/api/project/:projectID") {
    const body = await readJson(c);
    if (typeof body === "string") return body;
    if ("commands" in body) return "project commands cannot be changed through opencode-rc";
    const icon = body.icon;
    if (uploadsOff && isObject(icon) && typeof icon.override === "string" && icon.override.toLowerCase().startsWith("data:")) {
      return MESSAGES.uploads;
    }
    return null;
  }
  // The command's text holds its arguments, which go into the template before !`cmd` runs.
  if (!features.shell.enabled && template === "/api/session/:sessionID/command") {
    const body = await readJson(c);
    if (typeof body === "string") return body;
    if (hasShellInterpolation(body.text)) return MESSAGES.shell;
  }
  const downloadsOff = !features.downloads.enabled;
  if ((uploadsOff || downloadsOff) && (template === "/api/session/:sessionID/prompt" || template === "/api/session/:sessionID/command")) {
    const body = await readJson(c);
    if (typeof body === "string") return body;
    // 2.x sends top-level files; 1.18's /api prompt nests them in prompt. Check both.
    const files = [body.files, isObject(body.prompt) ? body.prompt.files : undefined].flatMap((l) => (Array.isArray(l) ? l : []));
    if (uploadsOff && files.some((f) => !isObject(f) || !isFileUri(f.uri))) return MESSAGES.uploads;
    // The server reads every uri that does not start with data: (core session/prompt.ts
    // materializeAttachment), so with both toggles off no attachment gets through.
    if (downloadsOff && files.some((f) => !isObject(f) || typeof f.uri !== "string" || !f.uri.startsWith("data:"))) {
      return MESSAGES.downloads;
    }
  }
  return null;
}

export function v2Guard(
  features: Features,
  deps: { fetchServerInfo?: (c: Context<ProxyEnv>) => Promise<ServerInfo> } = {},
): Guard {
  const fetchServerInfo = deps.fetchServerInfo ?? defaultFetchServerInfo;
  return async (c, next) => {
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (method === "OPTIONS") return next();
    const path = canonicalPath(proxyRest(c.req.path, c.req.param("sessionId")!));
    if (path === null) return reject(c, "unsupported characters in path", `${method} undecodable path`);
    const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const route = ROUTES.find((r) => r.method === method && r.re.test(trimmed));
    if (!route || route.rule === "never") {
      return reject(c, "this opencode feature is not available through opencode-rc", `${method} ${trimmed}`);
    }
    if (route.rule !== "allow" && !features[route.rule].enabled) {
      return reject(c, MESSAGES[route.rule], `${method} ${trimmed}`);
    }
    const denied = await checkRequest(c, route.template, features, fetchServerInfo);
    if (denied) return reject(c, denied, `${method} ${trimmed}`);
    await next();
  };
}

export function v2Guards(config: RcConfig): Guard {
  return every(
    plainPathGuard((c) => c.json({ _tag: "FeatureDisabled", message: "unsupported characters in path" }, 400)),
    v2Guard(config.opencodeV2.features),
  );
}
