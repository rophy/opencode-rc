import { apiUrl } from "./server"
import { authFetch, hasSession } from "./auth"

export * from "./server"

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
  if (!hasSession()) return null
  const res = await authFetch(apiUrl("/api/me"))
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`/api/me failed: ${res.status}`)
  return res.json()
}

export async function fetchSessions(): Promise<DevSession[]> {
  const res = await authFetch(apiUrl("/gateway/sessions"))
  if (!res.ok) return []
  return res.json()
}
