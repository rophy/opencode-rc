// Prints the nginx security headers for the web image, from the same config the bundle was
// built with (OPENCODE_RC_CONFIG). Run by ui/web/Dockerfile: bun run web/security-headers.ts
import fs from "node:fs"
import { parseConfig, parseConfigText } from "../../config/schema"
import { contentSecurityPolicy } from "../csp"

const file = process.env.OPENCODE_RC_CONFIG
const config = file ? parseConfigText(fs.readFileSync(file, "utf8"), file) : parseConfig({})
const csp = contentSecurityPolicy(config.serverUrl, { frameAncestors: true })

process.stdout.write(
  [
    `add_header Content-Security-Policy "${csp}" always;`,
    `add_header X-Content-Type-Options "nosniff" always;`,
    `add_header Referrer-Policy "no-referrer" always;`,
    "",
  ].join("\n"),
)
