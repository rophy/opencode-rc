import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "com.opencode.rc",
  appName: "OpenCode RC",
  webDir: "dist",
  server: {
    androidScheme: "https",
    // The WebView only shows the bundled app: sign-in runs in the system browser
    // (SystemAuth plugin) and every other link opens there too.
    allowNavigation: [],
  },
}

export default config
