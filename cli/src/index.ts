#!/usr/bin/env node
// cli/src/index.ts

import { loadConfig } from "./config.js";

async function main() {
  const config = loadConfig();
  console.log("opencode-rc starting...");
  console.log(`Gateway: ${config.gatewayUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
