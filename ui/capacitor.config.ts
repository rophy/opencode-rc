import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "com.opencode.rc",
  appName: "OpenCode RC",
  webDir: "dist",
  server: {
    androidScheme: "https",
    // The WebView only shows the bundled app: sign-in runs in the SystemAuth plugin
    // (iOS: its own sheet; Android: a Custom Tab) and every other link opens in the browser.
    allowNavigation: [],
  },
}

export default config
