#!/usr/bin/env node
// cli/src/index.ts

import { loadConfig } from "./config.js";
import { authorizationCodeAuth } from "./oidc.js";
import { startServer } from "./server.js";
import { startTunnelWithReconnect } from "./tunnel.js";
import { ProtocolError } from "./protocol.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

function generateSessionID(): string {
  return `${hostname()}-${randomUUID().slice(0, 8)}`;
}

async function main() {
  const config = await loadConfig();

  let idToken: string;
  if (process.env.OPENCODE_RC_TOKEN) {
    idToken = process.env.OPENCODE_RC_TOKEN;
    console.log("opencode-rc — using token from OPENCODE_RC_TOKEN");
  } else {
    console.log("opencode-rc — authenticating...");
    const auth = await authorizationCodeAuth(config);
    idToken = auth.idToken;
    console.log("Authenticated successfully.\n");
  }

  const server = await startServer();

  const sessionID = process.env.OPENCODE_RC_SESSION_ID || generateSessionID();
  const tunnel = await startTunnelWithReconnect(
    config,
    idToken,
    sessionID,
    server.url,
    process.cwd(),
    (err) => {
      console.error(err.message);
      server.close();
      process.exit(1);
    }
  );

  console.log(`\nSession "${sessionID}" connected.`);
  console.log("Press Ctrl+C to stop.\n");

  const shutdown = async () => {
    console.log("\nShutting down...");
    tunnel.close();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  if (err instanceof ProtocolError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
