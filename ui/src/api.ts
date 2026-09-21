const STORAGE_KEY = "opencode-rc-endpoint"

export function getBaseUrl(): string {
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

export interface UserInfo {
  sub: string
  email: string
  name: string
}

export interface DevSession {
  id: string
  userID: string
  endpoint: string
  directory: string
  lastHeartbeat: string
}

export async function fetchMe(): Promise<UserInfo | null> {
  const res = await fetch(apiUrl("/api/me"))
  if (res.status === 401 || res.status === 302) return null
  if (!res.ok) throw new Error(`/api/me failed: ${res.status}`)
  return res.json()
}

export async function fetchSessions(): Promise<DevSession[]> {
  const res = await fetch(apiUrl("/gateway/sessions"))
  if (!res.ok) return []
  return res.json()
}
