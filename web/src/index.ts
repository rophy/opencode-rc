import { Hono } from "hono";
import { logger } from "hono/logger";
import Redis from "ioredis";
import { loadConfig } from "./config.js";
import { discoverOIDC, createProvider } from "./oidc.js";
import { authRoutes, authMiddleware, type AuthEnv } from "./auth.js";
import { SessionStore } from "./store.js";
import { sessionHandler, rootWebUiHandler, serveStaticFile } from "./webui.js";

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
const discovery = await discoverOIDC(config.oidcIssuer);
const provider = createProvider(discovery);
console.log("OIDC discovery complete");

const app = new Hono<AuthEnv>();
app.use("*", logger());

// Health check (no auth)
app.get("/healthz", async (c) => {
  const ok = await store.ping();
  return c.json({ status: ok ? "ok" : "degraded", version });
});

// Auth routes (no auth middleware)
app.route("/", authRoutes(config, provider));

// Protected routes
const auth = authMiddleware(config);

app.get("/api/me", auth, (c) => {
  const session = c.get("session");
  return c.json({
    sub: session.uid,
    email: session.email,
    name: session.name,
  });
});

app.get("/gateway/sessions", auth, async (c) => {
  const userId = c.get("userId");
  const sessions = await store.list(userId);
  return c.json(sessions.map((s) => ({ ...s, user: s.userId })));
});

// Session routes: /s/:sessionId/*
app.all("/s/:sessionId", auth, (c) => {
  return c.redirect(`${c.req.path}/`);
});

app.all("/s/:sessionId/*", auth, sessionHandler(store, config.webUiDir));

// Static assets from SPA build (no auth — SPA handles login flow)
if (config.webUiDir) {
  app.get("/assets/*", (c) => {
    return serveStaticFile(config.webUiDir, c.req.path);
  });
}

// Root: serve web UI or fallback dashboard
if (config.webUiDir) {
  app.get("/", rootWebUiHandler(config.webUiDir));
} else {
  app.get("/", auth, (c) => {
    return c.html(dashboardHTML);
  });
}

console.log(`web starting version=${version} addr=:${config.port}`);

export default {
  port: config.port,
  fetch: app.fetch,
};

const dashboardHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>opencode-rc</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 2rem; }
    h1 { margin-bottom: 1.5rem; font-size: 1.5rem; }
    .sessions { display: grid; gap: 1rem; max-width: 600px; }
    .session { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; }
    .session a { color: #58a6ff; text-decoration: none; font-weight: 600; font-size: 1.1rem; }
    .session a:hover { text-decoration: underline; }
    .session .meta { color: #8b949e; font-size: 0.85rem; margin-top: 0.5rem; }
    .empty { color: #8b949e; }
  </style>
</head>
<body>
  <h1>opencode-rc</h1>
  <div id="sessions" class="sessions"><p class="empty">Loading...</p></div>
  <script>
    fetch('/gateway/sessions')
      .then(r => r.json())
      .then(sessions => {
        const el = document.getElementById('sessions');
        if (!sessions.length) {
          el.innerHTML = '<p class="empty">No active sessions. Run opencode-rc on your dev machine to get started.</p>';
          return;
        }
        el.innerHTML = '';
        sessions.forEach(s => {
          const div = document.createElement('div');
          div.className = 'session';
          const a = document.createElement('a');
          a.href = '/s/' + encodeURIComponent(s.id) + '/';
          a.textContent = s.directory;
          div.appendChild(a);
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = 'Session ' + s.id.slice(0, 8);
          div.appendChild(meta);
          el.appendChild(div);
        });
      });
  </script>
</body>
</html>`;
