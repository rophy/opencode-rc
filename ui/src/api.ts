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
  const res = await fetch("/api/me")
  if (res.status === 401 || res.status === 302) return null
  if (!res.ok) throw new Error(`/api/me failed: ${res.status}`)
  return res.json()
}

export async function fetchSessions(): Promise<DevSession[]> {
  const res = await fetch("/gateway/sessions")
  if (!res.ok) return []
  return res.json()
}
