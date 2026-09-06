#!/usr/bin/env node
// cli/src/index.ts

import { loadConfig } from "./config.js";
import { deviceFlowAuth } from "./oidc.js";
import { startServer } from "./server.js";
import {
  generateSessionID,
  registerWithGateway,
  startHeartbeat,
  deregisterFromGateway,
} from "./register.js";

async function main() {
  const config = loadConfig();
  const cwd = process.cwd();

  console.log("opencode-rc — authenticating...");
  const { idToken } = await deviceFlowAuth(config);
  console.log("Authenticated successfully.\n");

  const gatewayOrigin = new URL(config.gatewayUrl).origin;
  const server = await startServer(gatewayOrigin);

  const sessionID = generateSessionID();
  await registerWithGateway(config, idToken, sessionID, server.url, cwd);

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
