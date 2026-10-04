import { readFileSync } from "node:fs";
import { parseConfig, parseConfigText, type RcConfig } from "../../config/schema.js";

// The deployment's config.json, the same file the UI is built from. The API enforces its
// feature flags and ignores serverUrl. Without a file every feature is enabled; a missing
// or invalid file stops startup.
export function loadRcConfig(path = process.env.OPENCODE_RC_CONFIG): RcConfig {
  if (!path) return parseConfig({});
  return parseConfigText(readFileSync(path, "utf8"), path);
}
