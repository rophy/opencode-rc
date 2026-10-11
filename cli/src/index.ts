#!/usr/bin/env node
// cli/src/index.ts

import { loadConfig } from "./config.js";
import { authorizationCodeAuth } from "./oidc.js";
import { classifyOpencodeVersion, detectOpencodeVersion } from "./opencode-version.js";
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

  // Check opencode first, so a missing or unsupported opencode is reported before signing in.
  let output: string;
  try {
    output = detectOpencodeVersion();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const check = classifyOpencodeVersion(output);
  let opencodeVersion = "";
  if (check.kind === "needs-newer-cli") {
    console.error(
      `opencode 2.x needs a newer opencode-rc (found opencode ${check.version}). Use opencode 1.x for now.`,
    );
    process.exit(1);
  } else if (check.kind === "unsupported") {
    console.error(`opencode ${check.version} is not supported. opencode-rc supports opencode 1.x.`);
    process.exit(1);
  } else if (check.kind === "unknown") {
    console.error(
      `Warning: could not determine a supported opencode release from "${output.trim()}"; continuing as opencode 1.x.`,
    );
  } else {
    opencodeVersion = check.version;
    console.log(`opencode ${opencodeVersion}`);
  }

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

  const server = await startServer(1);

  const sessionID = process.env.OPENCODE_RC_SESSION_ID || generateSessionID();
  const tunnel = await startTunnelWithReconnect(
    config,
    idToken,
    sessionID,
    { url: server.url },
    process.cwd(),
    opencodeVersion,
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
