import { apiUrl } from "./server"
import { authFetch, hasSession } from "./auth"

export * from "./server"

export interface UserInfo {
  sub: string
  email: string
  name: string
}

// A connected dev machine, as /gateway/sessions returns it. The gateway removes the
// record when the tunnel closes, so every listed session is connected now.
export interface DevSession {
  id: string
  userId: string
  directory: string
  gatewayAddr: string
  /** When the current tunnel connected (ISO 8601). */
  createdAt: string
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
