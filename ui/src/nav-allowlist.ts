// Which hosts the native app's WebView may load, derived from the app's build-time
// config.json. Every other host opens in the system browser. Shared by capacitor.config.ts
// (native allowNavigation) and the UI (config screen), so it must not import anything.

export interface AppConfig {
  serverUrl?: string
  oidc?: { issuer?: string }
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname || undefined
  } catch {
    return undefined
  }
}

// The API host (sign-in starts and ends there) and the OIDC issuer host (login pages).
export function deriveAllowNavigation(config: AppConfig | undefined): string[] {
  const hosts = [hostOf(config?.serverUrl), hostOf(config?.oidc?.issuer)]
  return [...new Set(hosts.filter((h): h is string => !!h))]
}

// Same rules as Capacitor's allowNavigation: case-insensitive, same number of labels,
// "*" matches exactly one label, and a bare "*" matches every host.
export function hostAllowed(host: string, patterns: string[]): boolean {
  const hostParts = host.toLowerCase().split(".")
  return patterns.some((pattern) => {
    if (pattern === "*") return true
    const parts = pattern.toLowerCase().split(".")
    return parts.length === hostParts.length && parts.every((p, i) => p === "*" || p === hostParts[i])
  })
}
