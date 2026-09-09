#!/usr/bin/env node
// cli/src/index.ts

import { loadConfig } from "./config.js";
import { authorizationCodeAuth } from "./oidc.js";
import { startServer } from "./server.js";
import {
  generateSessionID,
  registerWithGateway,
  startHeartbeat,
  deregisterFromGateway,
} from "./register.js";

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

  const endpoint = process.env.OPENCODE_RC_ENDPOINT || server.url;
  const sessionID = process.env.OPENCODE_RC_SESSION_ID || generateSessionID();
  await registerWithGateway(config, idToken, sessionID, endpoint, process.cwd());

  const stopHeartbeat = startHeartbeat(config, idToken, sessionID);

  console.log(`\nSession available at: ${config.gatewayUrl}/s/${sessionID}/`);
  console.log("Press Ctrl+C to stop.\n");

  const shutdown = async () => {
    console.log("\nShutting down...");
    stopHeartbeat();
    await deregisterFromGateway(config, idToken, sessionID);
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
