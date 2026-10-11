import type { MiddlewareHandler } from "hono";
import { isObject } from "./body-guard.js";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";

type Json = Record<string, unknown>;

// opencode 1.x returns provider credentials to any client: each provider's key (from an env var
// or a stored API key, vendor/opencode-v1/packages/opencode/src/provider/provider.ts; toPublicInfo
// keeps it), and options and headers that hold apiKey, Authorization and the like (from config
// and the custom loaders). 1.18's /api routes carry them in request.headers, request.body and
// api.settings (packages/core/src/catalog.ts). The 1.x UI reads none of these fields, nor the
// contents of a model's variants (only their names), so they are removed whole rather than
// picked over by name.

const omit = (value: Json, names: string[]): Json => Object.fromEntries(Object.entries(value).filter(([name]) => !names.includes(name)));
const mapRecord = (value: unknown, fn: (item: unknown) => unknown) =>
  isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fn(v)])) : value;
const mapArray = (value: unknown, fn: (item: unknown) => unknown) => (Array.isArray(value) ? value.map(fn) : value);
const patch = (value: unknown, fn: (item: Json) => Json) => (isObject(value) ? fn(value) : value);

// A 1.x provider (Provider.Info, or a provider entry of the config): key and options; per model
// options and headers, and the variants' option sets (their names stay for the variant picker).
function legacyProvider(provider: unknown): unknown {
  return patch(provider, (p) => {
    const out = omit(p, ["key", "options", "headers"]);
    if ("models" in p) {
      out.models = mapRecord(p.models, (model) =>
        patch(model, (m) => {
          const clean = omit(m, ["options", "headers"]);
          if ("variants" in m) clean.variants = mapRecord(m.variants, () => ({}));
          return clean;
        }),
      );
    }
    return out;
  });
}

// A 1.18 provider or model (ProviderV2.Info, ModelV2.Info in packages/schema/src): request and
// api.settings; model variants keep only their id.
function apiItem(item: unknown): unknown {
  return patch(item, (i) => {
    const out = omit(i, ["request"]);
    if ("api" in i) out.api = patch(i.api, (api) => omit(api, ["settings"]));
    if ("variants" in i) out.variants = mapArray(i.variants, (v) => patch(v, (variant) => omit(variant, ["headers", "body"])));
    return out;
  });
}

// An MCP server entry of the config (packages/core/src/v1/config/mcp.ts): a local server's
// environment, a remote server's headers and its OAuth client secret. The 1.x UI reads no MCP
// entry of the config; it lists servers from GET /mcp.
function mcpServer(server: unknown): unknown {
  return patch(server, (s) => {
    const out = omit(s, ["environment", "headers"]);
    if ("oauth" in s) out.oauth = patch(s.oauth, (oauth) => omit(oauth, ["clientSecret"]));
    return out;
  });
}

const field = (name: string, fn: (value: unknown) => unknown) => (json: unknown) =>
  patch(json, (j) => (name in j ? { ...j, [name]: fn(j[name]) } : j));

// The 1.x GET routes that return providers, relative to the session (canonical path without a
// trailing slash), and how each response is cleaned. /provider and /config/providers are the
// legacy routes (Provider.ListResult and ConfigProvidersResult); 1.18's /api routes wrap their
// data in { location, data }. /config and /global/config return the config, whose provider
// entries hold the same options (the UI reads only a provider's npm and model names there),
// and whose MCP entries hold credentials too.
const ROUTES: { path: RegExp; strip: (json: unknown) => unknown }[] = [
  { path: /^\/provider$/, strip: field("all", (all) => mapArray(all, legacyProvider)) },
  { path: /^\/config\/providers$/, strip: field("providers", (list) => mapArray(list, legacyProvider)) },
  {
    path: /^\/(global\/)?config$/,
    strip: (json) => field("mcp", (servers) => mapRecord(servers, mcpServer))(field("provider", (providers) => mapRecord(providers, legacyProvider))(json)),
  },
  { path: /^\/api\/provider$/, strip: field("data", (data) => mapArray(data, apiItem)) },
  { path: /^\/api\/provider\/[^/]+$/, strip: field("data", apiItem) },
  { path: /^\/api\/model$/, strip: field("data", (data) => mapArray(data, apiItem)) },
];

export function providerSecretsStrip(rest: string): ((json: unknown) => unknown) | null {
  const path = canonicalPath(rest);
  if (path === null) return null;
  const bare = path.replace(/\/+$/, "");
  return ROUTES.find((r) => r.path.test(bare))?.strip ?? null;
}

// Removes provider keys, options and headers (and MCP credentials from the config) from the 1.x
// provider and config responses, for every 1.x session whatever the toggles. The proxy buffers and rewrites only these GET
// responses (proxyHttp, rewriteJson); everything else streams through untouched.
export function providerSecretsGuard(): MiddlewareHandler<ProxyEnv> {
  return async (c, next) => {
    if (c.req.method === "GET") {
      const strip = providerSecretsStrip(proxyRest(c.req.path, c.req.param("sessionId")!));
      if (strip) c.set("rewriteJson", strip);
    }
    await next();
  };
}
