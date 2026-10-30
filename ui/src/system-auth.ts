import { registerPlugin } from "@capacitor/core"

// Native sign-in (iOS: WKWebView sheet owned by the app / Android: Custom Tabs); see
// ui/ios/App/App/SystemAuthPlugin.swift and ui/android/.../SystemAuthPlugin.java.
// Rejections carry code "cancelled" (user closed it) or "failed".
export interface SystemAuthPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string }>
}

export const SystemAuth = registerPlugin<SystemAuthPlugin>("SystemAuth")
