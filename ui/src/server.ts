import { buildConfig } from "./build-config"

const STORAGE_KEY = "opencode-rc-endpoint"

// A server compiled into the build (config.json serverUrl) wins over the one the user enters.
let preConfiguredUrl: string | undefined = buildConfig.serverUrl

export function isPreConfigured(): boolean {
  return !!preConfiguredUrl
}

// Tests only: preset a server as if it was compiled in.
export function presetServerUrl(url: string | undefined) {
  preConfiguredUrl = url?.replace(/\/+$/, "")
}

// Tests only: back to the build-time server.
export function resetConfig() {
  preConfiguredUrl = buildConfig.serverUrl
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
