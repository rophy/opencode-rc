import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "com.opencode.rc",
  appName: "OpenCode RC",
  webDir: "dist",
  server: {
    androidScheme: "https",
    allowNavigation: ["*"],
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
}

export default config
