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
  let major: 1 | 2 = 1;
  if (check.kind === "unsupported") {
    console.error(`opencode ${check.version} is not supported. opencode-rc supports opencode 1.x and 2.x.`);
    process.exit(1);
  } else if (check.kind === "unknown") {
    console.error(
      `Warning: could not determine a supported opencode release from "${output.trim()}"; continuing as opencode 1.x.`,
    );
  } else {
    opencodeVersion = check.version;
    major = check.kind === "v2" ? 2 : 1;
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

  let tunnel: { close(): void } | undefined;
  // Ctrl+C signals the whole process group, so the child can exit before our handler runs.
  let shuttingDown = false;
  const onSignal = () => {
    shuttingDown = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const server = await startServer(major, {
    onExit: () => {
      if (shuttingDown) return;
      console.error("opencode stopped unexpectedly. Stopping.");
      tunnel?.close();
      process.exit(1);
    },
  });

  const sessionID = process.env.OPENCODE_RC_SESSION_ID || generateSessionID();
  tunnel = await startTunnelWithReconnect(
    config,
    idToken,
    sessionID,
    server,
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
    tunnel?.close();
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
