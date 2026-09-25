import { deriveAllowNavigation } from "./nav-allowlist"

const STORAGE_KEY = "opencode-rc-endpoint"

let preConfiguredUrl: string | undefined
let allowNavigation: string[] = []

export async function loadConfig(): Promise<void> {
  try {
    const res = await fetch("/config.json", { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return
    const config = await res.json()
    if (config.serverUrl) {
      preConfiguredUrl = config.serverUrl.replace(/\/+$/, "")
    }
    allowNavigation = deriveAllowNavigation(config)
  } catch {}
}

export function isPreConfigured(): boolean {
  return !!preConfiguredUrl
}

export function resetConfig() {
  preConfiguredUrl = undefined
  allowNavigation = []
}

// Hosts the native WebView may load (same derivation as capacitor.config.ts).
export function navigationAllowlist(): string[] {
  return allowNavigation
}

export function getBaseUrl(): string {
  if (preConfiguredUrl) return preConfiguredUrl
  try {
    return localStorage.getItem(STORAGE_KEY) || ""
  } catch {
    return ""
  }
}

export function setBaseUrl(url: string) {
  try {
    if (url) {
      localStorage.setItem(STORAGE_KEY, url.replace(/\/+$/, ""))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {}
}

export async function isConfigured(): Promise<boolean> {
  if (getBaseUrl()) return true
  try {
    const res = await fetch("/healthz", { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

export function apiUrl(path: string): string {
  const base = getBaseUrl()
  return base ? `${base}${path}` : path
}
