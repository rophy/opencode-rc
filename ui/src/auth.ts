import { apiUrl, getBaseUrl } from "./server"

export const REFRESH_KEY = "opencode-rc-refresh"
const EARLY_REFRESH_MS = 30_000

export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

let access: { token: string; expiresAt: number } | null = null
let inflight: Promise<string | null> | null = null
let loggedOutListener: (() => void) | null = null

function readRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

function writeRefresh(token: string | null) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token)
    else localStorage.removeItem(REFRESH_KEY)
  } catch {}
}

function save(res: TokenResponse) {
  access = { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 }
  writeRefresh(res.refresh_token)
}

function clear() {
  access = null
  writeRefresh(null)
}

function fresh(): string | null {
  return access && access.expiresAt - Date.now() > EARLY_REFRESH_MS ? access.token : null
}

function postJson(path: string, body: unknown) {
  return fetch(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function refreshNow(): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const current = fresh()
    if (current) return current
    // Re-read: another tab may have rotated the refresh token while we waited for the lock.
    const refreshToken = readRefresh()
    if (!refreshToken) return null
    const res = await postJson("/auth/refresh", { refresh_token: refreshToken })
    if (res.status === 400 || res.status === 401) {
      clear()
      loggedOutListener?.()
      return null
    }
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
    const body = (await res.json()) as TokenResponse
    save(body)
    return body.access_token
  }
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  return locks?.request ? locks.request("orc-refresh", run) : run()
}

export function hasSession(): boolean {
  return !!readRefresh()
}

export function getCachedAccessToken(): string | null {
  return access && access.expiresAt > Date.now() ? access.token : null
}

export function invalidateAccessToken(): void {
  access = null
}

export function getAccessToken(): Promise<string | null> {
  const current = fresh()
  if (current) return Promise.resolve(current)
  inflight ??= refreshNow().finally(() => {
    inflight = null
  })
  return inflight
}

export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string | null) => {
    const headers = new Headers(init.headers)
    if (token) headers.set("authorization", `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  }
  const res = await send(await getAccessToken())
  if (res.status !== 401 || !hasSession()) return res
  invalidateAccessToken()
  return send(await getAccessToken())
}

export function login(): void {
  // Served by the server itself: return to a path. Otherwise (the app): absolute URL.
  const returnTo = getBaseUrl()
    ? window.location.href.split("#")[0]
    : window.location.pathname + window.location.search
  window.location.href = apiUrl(`/auth/start?return_to=${encodeURIComponent(returnTo)}`)
}

export async function completeLogin(): Promise<"none" | "ok" | "expired"> {
  const match = window.location.hash.match(/(?:^#|&)code=([^&]+)/)
  if (!match) return "none"
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
  try {
    const res = await postJson("/auth/token", { code: decodeURIComponent(match[1]) })
    if (!res.ok) return "expired"
    save((await res.json()) as TokenResponse)
    return "ok"
  } catch {
    return "expired"
  }
}

export async function logout(): Promise<void> {
  const refreshToken = readRefresh()
  clear()
  if (refreshToken) {
    await postJson("/auth/logout", { refresh_token: refreshToken }).catch(() => undefined)
  }
}

export function onLoggedOut(cb: () => void): void {
  loggedOutListener = cb
}

export function resetAuthState(): void {
  access = null
  inflight = null
  loggedOutListener = null
}
