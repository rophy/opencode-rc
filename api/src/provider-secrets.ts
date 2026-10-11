import type { MiddlewareHandler } from "hono";
import { isObject } from "./body-guard.js";
import { canonicalPath, proxyRest, type ProxyEnv } from "./proxy.js";

type Json = Record<string, unknown>;

// Provider options that hold a secret. opencode 1.x puts them in each provider's options
// (vendor/opencode-v1/packages/opencode/src/provider/provider.ts: config options, and the
// custom loaders for gitlab, cloudflare-workers-ai and snowflake-cortex set apiKey from env or
// stored keys), and 1.18's /api routes in request.body and api.settings
// (packages/core/src/catalog.ts, session/runner/model.ts). Matched ignoring case:
// - apiKey: every AI SDK provider;
// - authToken: @ai-sdk/anthropic (core/src/v1/config/provider-options.ts treats it as one);
// - token: snowflake-cortex reads it as its bearer token (provider.ts);
// - accessKeyId, secretAccessKey, sessionToken: @ai-sdk/amazon-bedrock;
// - googleAuthOptions: @ai-sdk/google-vertex, holds the service account credentials;
// - credentials, serviceAccount: no provider in the pinned source sets them at the top level;
//   removed in case a config does.
const SECRET_OPTIONS = new Set([
  "apikey",
  "authtoken",
  "token",
  "accesskeyid",
  "secretaccesskey",
  "sessiontoken",
  "googleauthoptions",
  "credentials",
  "serviceaccount",
]);

// Request headers that carry a provider credential, matched ignoring case: authorization and
// proxy-authorization (bearer keys, copilot), x-api-key (anthropic), api-key (azure),
// x-goog-api-key (google), private-token (gitlab).
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key", "private-token"]);

function withoutSecretHeaders(headers: unknown): unknown {
  if (!isObject(headers)) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase())));
}

// An options object (1.x options, 1.18 request.body and api.settings) without its secrets,
// including the headers it nests.
function withoutSecretOptions(options: unknown): unknown {
  if (!isObject(options)) return options;
  const out: Json = {};
  for (const [name, value] of Object.entries(options)) {
    if (SECRET_OPTIONS.has(name.toLowerCase())) continue;
    out[name] = name.toLowerCase() === "headers" ? withoutSecretHeaders(value) : value;
  }
  return out;
}

const mapRecord = (value: unknown, fn: (item: unknown) => unknown) =>
  isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fn(v)])) : value;
const mapArray = (value: unknown, fn: (item: unknown) => unknown) => (Array.isArray(value) ? value.map(fn) : value);
const patch = (value: unknown, fn: (item: Json) => Json) => (isObject(value) ? fn(value) : value);

// 1.x Provider.Info: key, options, and per model options, headers and variants (option sets).
function legacyProvider(provider: unknown): unknown {
  return patch(provider, ({ key: _key, ...rest }) => ({
    ...rest,
    ...("options" in rest && { options: withoutSecretOptions(rest.options) }),
    ...("models" in rest && {
      models: mapRecord(rest.models, (model) =>
        patch(model, (m) => ({
          ...m,
          ...("options" in m && { options: withoutSecretOptions(m.options) }),
          ...("headers" in m && { headers: withoutSecretHeaders(m.headers) }),
          ...("variants" in m && { variants: mapRecord(m.variants, withoutSecretOptions) }),
        })),
      ),
    }),
  }));
}

// 1.18 request shape ({ headers, body }), used by providers, models and model variants.
const request = (value: Json): Json => ({
  ...value,
  ...("headers" in value && { headers: withoutSecretHeaders(value.headers) }),
  ...("body" in value && { body: withoutSecretOptions(value.body) }),
});

// 1.18 ProviderV2.Info and ModelV2.Info (packages/schema/src): api.settings and request.
function apiItem(item: unknown): unknown {
  return patch(item, (i) => ({
    ...i,
    ...("api" in i && { api: patch(i.api, (api) => ({ ...api, ...("settings" in api && { settings: withoutSecretOptions(api.settings) }) })) }),
    ...("request" in i && { request: patch(i.request, request) }),
    ...("variants" in i && { variants: mapArray(i.variants, (v) => patch(v, request)) }),
  }));
}

const field = (name: string, fn: (value: unknown) => unknown) => (json: unknown) =>
  patch(json, (j) => (name in j ? { ...j, [name]: fn(j[name]) } : j));

// The 1.x GET routes that return providers, relative to the session (canonical path without a
// trailing slash), and how each response is cleaned. The 1.x UI reads none of the removed
// fields. /provider and /config/providers are the legacy routes (Provider.ListResult and
// ConfigProvidersResult); 1.18's /api routes wrap their data in { location, data }.
const ROUTES: { path: RegExp; strip: (json: unknown) => unknown }[] = [
  { path: /^\/provider$/, strip: field("all", (all) => mapArray(all, legacyProvider)) },
  { path: /^\/config\/providers$/, strip: field("providers", (list) => mapArray(list, legacyProvider)) },
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

// Removes provider API keys and secret options from the 1.x provider responses, for every 1.x
// session whatever the toggles: opencode returns them to any client
// (provider.ts toPublicInfo keeps key). The proxy buffers and rewrites only these GET
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
