import { Capacitor } from "@capacitor/core"
import { apiUrl, getBaseUrl } from "./server"
import { sha256 } from "./sha256"
import { SystemAuth } from "./system-auth"
import { checkProtocol, withProtocol } from "./protocol"

export const REFRESH_KEY = "opencode-rc-refresh"
export const VERIFIER_KEY = "opencode-rc-login-verifier"
const EARLY_REFRESH_MS = 30_000

// The mobile app's sign-in callback; must match APP_CALLBACK in api/src/origins.ts.
export const APP_CALLBACK_SCHEME = "com.opencode.rc"
export const APP_CALLBACK = `${APP_CALLBACK_SCHEME}:/auth/done`

export type LoginResult = "redirected" | "ok" | "cancelled" | "failed"

export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface RefreshTokenStore {
  get(): string | null
  set(token: string | null): void
}

const localStorageRefreshTokenStore: RefreshTokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(REFRESH_KEY)
    } catch {
      return null
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(REFRESH_KEY, token)
      else localStorage.removeItem(REFRESH_KEY)
    } catch {}
  },
}

let refreshTokenStore: RefreshTokenStore = localStorageRefreshTokenStore

export function setRefreshTokenStore(store: RefreshTokenStore): void {
  refreshTokenStore = store
}

let access: { token: string; expiresAt: number } | null = null
let inflight: Promise<string | null> | null = null
let loggedOutListener: (() => void) | null = null

function readRefresh(): string | null {
  return refreshTokenStore.get()
}

function writeRefresh(token: string | null) {
  refreshTokenStore.set(token)
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

async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(
    apiUrl(path),
    withProtocol({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
  await checkProtocol(res)
  return res
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
  const send = async (token: string | null) => {
    const headers = new Headers(init.headers)
    if (token) headers.set("authorization", `Bearer ${token}`)
    const res = await fetch(url, withProtocol({ ...init, headers }))
    await checkProtocol(res)
    return res
  }
  const res = await send(await getAccessToken())
  if (res.status !== 401 || !hasSession()) return res
  invalidateAccessToken()
  return send(await getAccessToken())
}

// The login verifier binds the login code to this client (PKCE-style): only the
// client that started the login can exchange the code it gets back.
function verifierStorage(): Storage {
  try {
    return window.sessionStorage
  } catch {
    return window.localStorage
  }
}

function saveVerifier(verifier: string) {
  try {
    verifierStorage().setItem(VERIFIER_KEY, verifier)
  } catch {}
}

function takeVerifier(): string | null {
  try {
    const storage = verifierStorage()
    const verifier = storage.getItem(VERIFIER_KEY)
    storage.removeItem(VERIFIER_KEY)
    return verifier
  } catch {
    return null
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(new TextEncoder().encode(verifier)))
}

function codeFromFragment(url: string): string | null {
  const match = url.match(/#(?:.*&)?code=([^&]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

async function exchangeCode(code: string, verifier: string): Promise<boolean> {
  try {
    const res = await postJson("/auth/token", { code, code_verifier: verifier })
    if (!res.ok) return false
    save((await res.json()) as TokenResponse)
    return true
  } catch {
    return false
  }
}

// Native apps sign in through the system browser (RFC 8252): the WebView never leaves
// the app, so the verifier stays in memory.
async function nativeLogin(verifier: string, challenge: string): Promise<LoginResult> {
  if (!getBaseUrl()) return "failed"
  let callback: string
  try {
    const result = await SystemAuth.start({
      url: apiUrl(`/auth/start?return_to=${encodeURIComponent(APP_CALLBACK)}&code_challenge=${challenge}`),
      callbackScheme: APP_CALLBACK_SCHEME,
    })
    callback = result.url
  } catch (err) {
    return (err as { code?: string } | null)?.code === "cancelled" ? "cancelled" : "failed"
  }
  const code = codeFromFragment(callback)
  if (!code) return "failed"
  return (await exchangeCode(code, verifier)) ? "ok" : "failed"
}

export async function login(): Promise<LoginResult> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = await codeChallenge(verifier)
  if (Capacitor.isNativePlatform()) return nativeLogin(verifier, challenge)

  saveVerifier(verifier)
  // Served by the server itself: return to a path. Otherwise (separate UI host): absolute URL.
  const returnTo = getBaseUrl()
    ? window.location.href.split("#")[0]
    : window.location.pathname + window.location.search
  window.location.href = apiUrl(
    `/auth/start?return_to=${encodeURIComponent(returnTo)}&code_challenge=${challenge}`,
  )
  return "redirected"
}

export async function completeLogin(): Promise<"none" | "ok" | "expired"> {
  const match = window.location.hash.match(/(?:^#|&)code=([^&]+)/)
  if (!match) return "none"
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
  const verifier = takeVerifier()
  if (!verifier) return "expired"
  let code: string
  try {
    code = decodeURIComponent(match[1])
  } catch {
    return "expired"
  }
  return (await exchangeCode(code, verifier)) ? "ok" : "expired"
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
  refreshTokenStore = localStorageRefreshTokenStore
}
