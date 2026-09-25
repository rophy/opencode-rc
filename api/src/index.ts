import { Hono } from "hono";
import { websocket } from "hono/bun";
import Redis from "ioredis";
import { loadConfig } from "./config.js";
import { discoverOIDC, createProvider } from "./oidc.js";
import { authRoutes, authMiddleware, type AuthEnv } from "./auth.js";
import { SessionStore } from "./store.js";
import { TokenStore, type RedisLike } from "./token-store.js";
import { corsMiddleware, makeOriginCheck, originOf } from "./origins.js";
import { proxyHttp, sessionAccess } from "./proxy.js";
import { wsRelay } from "./ws-relay.js";
import { reservedNotFound, spaHandler } from "./webui.js";
import { requestLogger } from "./request-log.js";

import pkg from "../package.json";
const version = pkg.version;

const config = loadConfig();

if (config.tlsInsecureSkipVerify) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("Warning: TLS certificate verification disabled");
}

console.log("Connecting to Redis...");
const redis = new Redis(config.redisUrl);
await redis.ping();
console.log("Connected to Redis");

const store = new SessionStore(redis);

console.log("Discovering OIDC...");
const discovery = await discoverOIDC(config.oidcIssuer, {
  issuer: config.oidcIssuerOverride,
  authorization_endpoint: config.oidcAuthorizationEndpoint,
  token_endpoint: config.oidcTokenEndpoint,
  jwks_uri: config.oidcJwksUri,
});
const provider = createProvider(discovery);
console.log("OIDC discovery complete");

const tokens = new TokenStore(redis as unknown as RedisLike, config.sessionTtl);
const isAllowedOrigin = makeOriginCheck(originOf(config.oidcRedirectUri), config.allowedOrigins);

const app = new Hono<AuthEnv>();
app.use("*", requestLogger());
app.use("*", corsMiddleware(isAllowedOrigin));

// Health check (no auth)
app.get("/healthz", async (c) => {
  const ok = await store.ping();
  return c.json({ status: ok ? "ok" : "degraded", version });
});

// Auth routes (no auth middleware)
app.route("/", authRoutes({ config, provider, tokens, isAllowedOrigin }));

// Protected routes
const auth = authMiddleware(config);

app.get("/api/me", auth, (c) => {
  const claims = c.get("claims");
  return c.json({ sub: claims.uid, email: claims.email, name: claims.name });
});

app.get("/gateway/sessions", auth, async (c) => {
  const userId = c.get("userId");
  const sessions = await store.list(userId);
  return c.json(sessions.map((s) => ({ ...s, user: s.userId })));
});

// OpenCode API proxy: WebSocket upgrades (GET only), else HTTP and SSE
app.all("/proxy/:sessionId/*", auth, sessionAccess(store), wsRelay(), proxyHttp());

// Unknown API paths: JSON 404, never the SPA
app.all("*", reservedNotFound());

// SPA: static files, client routes (including /s/:id/...) fall back to index.html
if (config.webUiDir) {
  app.get("*", spaHandler(config.webUiDir));
}

console.log(`api starting version=${version} addr=:${config.port}`);

export default {
  port: config.port,
  fetch: app.fetch,
  websocket,
};
