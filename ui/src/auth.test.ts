import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  REFRESH_KEY,
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

function tokens(n: number) {
  return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900 }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  localStorage.clear()
  resetConfig()
  resetAuthState()
})

afterEach(() => vi.restoreAllMocks())

describe("completeLogin", () => {
  it("does nothing without a code", async () => {
    window.history.replaceState(null, "", "/")
    expect(await completeLogin()).toBe("none")
  })

  it("exchanges the code, stores the refresh token and strips the fragment", async () => {
    window.history.replaceState(null, "", "/s/x/#code=abc")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tokens(1)))
    expect(await completeLogin()).toBe("ok")
    expect(window.location.hash).toBe("")
    expect(window.location.pathname).toBe("/s/x/")
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1")
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/auth/token")
    expect(JSON.parse(init.body as string)).toEqual({ code: "abc" })
    expect(await getAccessToken()).toBe("access-1")
  })

  it("reports an expired code", async () => {
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

    window.history.replaceState(null, "", "/#code=abc")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(tokens(1)))
    expect(await completeLogin()).toBe("ok")
    expect(store.value).toBe("refresh-1")
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()
  })
})

describe("login / logout", () => {
  it("login sends a relative return_to when served by the server", () => {
    window.history.replaceState(null, "", "/s/x/?a=1")
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      pathname: "/s/x/",
      search: "?a=1",
      set href(v: string) { assign(v) },
    } as unknown as Location)
    login()
    expect(assign).toHaveBeenCalledWith("/auth/start?return_to=%2Fs%2Fx%2F%3Fa%3D1")
  })

  it("login sends an absolute return_to with a configured server", () => {
    localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      get href() { return "https://localhost/#stale" },
      set href(v: string) { assign(v) },
    } as unknown as Location)
    login()
    expect(assign).toHaveBeenCalledWith(
      "https://rc.example.com/auth/start?return_to=https%3A%2F%2Flocalhost%2F",
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
