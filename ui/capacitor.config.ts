import { existsSync, readFileSync } from "node:fs"
import type { CapacitorConfig } from "@capacitor/cli"
import { deriveAllowNavigation } from "./src/nav-allowlist.ts"

// The app's build-time config.json (serverUrl, oidc.issuer), written into dist/ after
// `bun run build` and before `npx cap sync`. The WebView may load only the hosts derived
// from it; every other link opens in the system browser. No file: only the app loads.
const configPath = "dist/config.json"
const appConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : undefined

const config: CapacitorConfig = {
  appId: "com.opencode.rc",
  appName: "OpenCode RC",
  webDir: "dist",
  server: {
    androidScheme: "https",
    allowNavigation: deriveAllowNavigation(appConfig),
  },
}

export default config
