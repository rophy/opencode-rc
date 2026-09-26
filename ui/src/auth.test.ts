import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  REFRESH_KEY,
  VERIFIER_KEY,
  authFetch,
  completeLogin,
  getAccessToken,
  hasSession,
  login,
  logout,
  onLoggedOut,
  resetAuthState,
  setRefreshTokenStore,
  type RefreshTokenStore,
} from "./auth"
import { resetConfig } from "./server"
import { resetProtocolState } from "./protocol"

function tokens(n: number) {
  return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900 }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetConfig()
  resetAuthState()
  resetProtocolState()
})

afterEach(() => vi.restoreAllMocks())

describe("completeLogin", () => {
  it("does nothing without a code", async () => {
    window.history.replaceState(null, "", "/")
    expect(await completeLogin()).toBe("none")
  })

  it("exchanges the code, stores the refresh token and strips the fragment", async () => {
    sessionStorage.setItem(VERIFIER_KEY, "verifier-1")
    window.history.replaceState(null, "", "/s/x/#code=abc")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tokens(1)))
    expect(await completeLogin()).toBe("ok")
    expect(window.location.hash).toBe("")
    expect(window.location.pathname).toBe("/s/x/")
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1")
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/auth/token")
    expect(JSON.parse(init.body as string)).toEqual({ code: "abc", code_verifier: "verifier-1" })
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull()
    expect(await getAccessToken()).toBe("access-1")
  })

  it("reports expired without calling /auth/token when no login was started here", async () => {
    window.history.replaceState(null, "", "/s/x/#code=injected")
    const spy = vi.spyOn(globalThis, "fetch")
    expect(await completeLogin()).toBe("expired")
    expect(spy).not.toHaveBeenCalled()
    expect(window.location.hash).toBe("")
    expect(hasSession()).toBe(false)
  })

  it("reports an expired code", async () => {
    sessionStorage.setItem(VERIFIER_KEY, "verifier-1")
    window.history.replaceState(null, "", "/#code=old")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "invalid_grant" }, 400))
    expect(await completeLogin()).toBe("expired")
    expect(hasSession()).toBe(false)
  })
})

describe("getAccessToken", () => {
  it("returns null without a session", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    expect(await getAccessToken()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("refreshes once for concurrent callers", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tokens(1)))
    const [a, b] = await Promise.all([getAccessToken(), getAccessToken()])
    expect(a).toBe("access-1")
    expect(b).toBe("access-1")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1")
  })

  it("clears the session and notifies on invalid_grant", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "invalid_grant" }, 401))
    const cb = vi.fn()
    onLoggedOut(cb)
    expect(await getAccessToken()).toBeNull()
    expect(hasSession()).toBe(false)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe("authFetch", () => {
  it("adds the bearer header", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === "/auth/refresh" ? json(tokens(1)) : json({ ok: true }),
    )
    await authFetch("/api/me")
    const init = spy.mock.calls[1][1] as RequestInit
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-1")
  })

  it("refreshes and retries once on 401", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    let refreshes = 0
    let meCalls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/auth/refresh") return json(tokens(++refreshes))
      meCalls++
      return meCalls === 1 ? json({ error: "unauthorized" }, 401) : json({ ok: true })
    })
    const res = await authFetch("/api/me")
    expect(res.status).toBe(200)
    expect(refreshes).toBe(2)
    expect(meCalls).toBe(2)
  })
})

describe("protocol header", () => {
  it("authFetch and the token calls send the protocol header", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(tokens(1), 200),
    )
    await authFetch("/api/me")
    for (const [, init] of spy.mock.calls as [string, RequestInit][]) {
      expect(new Headers(init.headers).get("OpenCode-RC-Protocol")).toBe("1")
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2) // refresh + /api/me
  })
})

describe("setRefreshTokenStore", () => {
  function memoryStore(): RefreshTokenStore & { value: string | null } {
    return {
      value: null,
      get() {
        return this.value
      },
      set(token: string | null) {
        this.value = token
      },
    }
  }

  it("routes reads and writes through a custom store instead of localStorage", async () => {
    const store = memoryStore()
    setRefreshTokenStore(store)
    store.value = "refresh-custom"
    expect(hasSession()).toBe(true)
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()

    sessionStorage.setItem(VERIFIER_KEY, "verifier-1")
    window.history.replaceState(null, "", "/#code=abc")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tokens(1)))
    expect(await completeLogin()).toBe("ok")
    expect(store.value).toBe("refresh-1")
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()
  })
})

async function challengeOf(verifier: string | null) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier ?? "")))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

describe("login / logout", () => {
  it("login stores a verifier and sends its S256 challenge", async () => {
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      set href(v: string) { assign(v) },
    } as unknown as Location)
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    ) // RFC 7636 appendix B
    await login()
    const verifier = sessionStorage.getItem(VERIFIER_KEY)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const url = new URL(assign.mock.calls[0][0], "https://x.invalid")
    expect(url.searchParams.get("code_challenge")).toBe(await challengeOf(verifier))
  })

  it("login works without crypto.subtle (plain-http origins)", async () => {
    vi.spyOn(crypto, "subtle", "get").mockReturnValue(undefined as unknown as SubtleCrypto)
    expect(globalThis.crypto.subtle).toBeUndefined()
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      set href(v: string) { assign(v) },
    } as unknown as Location)
    await login()
    const verifier = sessionStorage.getItem(VERIFIER_KEY)
    vi.restoreAllMocks()
    const url = new URL(assign.mock.calls[0][0], "https://x.invalid")
    expect(url.searchParams.get("code_challenge")).toBe(await challengeOf(verifier))
  })

  it("login falls back to localStorage for the verifier", async () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("blocked")
    })
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      set href(v: string) { assign(v) },
    } as unknown as Location)
    await login()
    const verifier = localStorage.getItem(VERIFIER_KEY)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const url = new URL(assign.mock.calls[0][0], "https://x.invalid")
    expect(url.searchParams.get("code_challenge")).toBe(await challengeOf(verifier))
  })

  it("login sends a relative return_to when served by the server", async () => {
    window.history.replaceState(null, "", "/s/x/?a=1")
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      pathname: "/s/x/",
      search: "?a=1",
      set href(v: string) { assign(v) },
    } as unknown as Location)
    await login()
    const challenge = await challengeOf(sessionStorage.getItem(VERIFIER_KEY))
    expect(assign).toHaveBeenCalledWith(
      `/auth/start?return_to=%2Fs%2Fx%2F%3Fa%3D1&code_challenge=${challenge}`,
    )
  })

  it("login sends an absolute return_to with a configured server", async () => {
    localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      get href() { return "https://localhost/#stale" },
      set href(v: string) { assign(v) },
    } as unknown as Location)
    await login()
    const challenge = await challengeOf(sessionStorage.getItem(VERIFIER_KEY))
    expect(assign).toHaveBeenCalledWith(
      `https://rc.example.com/auth/start?return_to=https%3A%2F%2Flocalhost%2F&code_challenge=${challenge}`,
    )
  })

  it("logout revokes and clears", async () => {
    localStorage.setItem(REFRESH_KEY, "refresh-0")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
    await logout()
    expect(hasSession()).toBe(false)
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/auth/logout")
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: "refresh-0" })
  })
})
