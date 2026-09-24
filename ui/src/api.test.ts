import { describe, it, expect, beforeEach, vi } from "vitest"
import { getBaseUrl, setBaseUrl, apiUrl, isConfigured, isPreConfigured, loadConfig, resetConfig, fetchMe, fetchSessions } from "./api"
import { resetAuthState } from "./auth"

beforeEach(() => {
  localStorage.clear()
  resetConfig()
  resetAuthState()
})

describe("getBaseUrl / setBaseUrl", () => {
  it("returns empty string when nothing saved", () => {
    expect(getBaseUrl()).toBe("")
  })

  it("stores and retrieves a URL", () => {
    setBaseUrl("https://example.com")
    expect(getBaseUrl()).toBe("https://example.com")
  })

  it("strips trailing slashes", () => {
    setBaseUrl("https://example.com///")
    expect(getBaseUrl()).toBe("https://example.com")
  })

  it("clears the URL when set to empty string", () => {
    setBaseUrl("https://example.com")
    setBaseUrl("")
    expect(getBaseUrl()).toBe("")
  })

  it("returns empty string when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(getBaseUrl()).toBe("")
    vi.restoreAllMocks()
  })
})

describe("apiUrl", () => {
  it("returns path unchanged when no base URL is set", () => {
    expect(apiUrl("/api/me")).toBe("/api/me")
  })

  it("prepends base URL when configured", () => {
    setBaseUrl("https://rc.example.com")
    expect(apiUrl("/api/me")).toBe("https://rc.example.com/api/me")
    expect(apiUrl("/gateway/sessions")).toBe("https://rc.example.com/gateway/sessions")
  })
})

describe("isConfigured", () => {
  it("returns true when base URL is set", async () => {
    setBaseUrl("https://example.com")
    expect(await isConfigured()).toBe(true)
  })

  it("returns true when /healthz is reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }))
    expect(await isConfigured()).toBe(true)
    vi.restoreAllMocks()
  })

  it("returns false when /healthz is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"))
    expect(await isConfigured()).toBe(false)
    vi.restoreAllMocks()
  })

  it("returns false when /healthz returns non-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 502 }))
    expect(await isConfigured()).toBe(false)
    vi.restoreAllMocks()
  })
})

function mockFetchWithRefresh(otherUrlPart: string, otherResponse: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/auth/refresh")) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "a", refresh_token: "r2", expires_in: 900 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    }
    if (url.includes(otherUrlPart)) return Promise.resolve(otherResponse())
    throw new Error(`unexpected fetch: ${url}`)
  })
}

describe("fetchMe", () => {
  it("returns user info on success", async () => {
    localStorage.setItem("opencode-rc-refresh", "r")
    const user = { sub: "alice", email: "alice@example.com", name: "Alice" }
    mockFetchWithRefresh(
      "/api/me",
      () => new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })
    )
    expect(await fetchMe()).toEqual(user)
    vi.restoreAllMocks()
  })

  it("returns null on 401", async () => {
    localStorage.setItem("opencode-rc-refresh", "r")
    mockFetchWithRefresh("/api/me", () => new Response("", { status: 401 }))
    expect(await fetchMe()).toBeNull()
    vi.restoreAllMocks()
  })

  it("uses base URL when configured", async () => {
    localStorage.setItem("opencode-rc-refresh", "r")
    setBaseUrl("https://rc.example.com")
    const user = { sub: "alice", email: "alice@example.com", name: "Alice" }
    const spy = mockFetchWithRefresh(
      "/api/me",
      () => new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })
    )
    await fetchMe()
    expect(spy.mock.calls.some(([u]) => u === "https://rc.example.com/api/me")).toBe(true)
    vi.restoreAllMocks()
  })

  it("fetchMe returns null without a session and makes no request", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    expect(await fetchMe()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("fetchSessions", () => {
  it("returns sessions on success", async () => {
    localStorage.setItem("opencode-rc-refresh", "r")
    const sessions = [{ id: "s1", userID: "u1", endpoint: "e", directory: "/p", lastHeartbeat: "2026-01-01T00:00:00Z" }]
    mockFetchWithRefresh(
      "/gateway/sessions",
      () => new Response(JSON.stringify(sessions), { status: 200, headers: { "content-type": "application/json" } })
    )
    expect(await fetchSessions()).toEqual(sessions)
    vi.restoreAllMocks()
  })

  it("returns empty array on error", async () => {
    localStorage.setItem("opencode-rc-refresh", "r")
    mockFetchWithRefresh("/gateway/sessions", () => new Response("", { status: 500 }))
    expect(await fetchSessions()).toEqual([])
    vi.restoreAllMocks()
  })
})

describe("loadConfig / isPreConfigured", () => {
  it("is not pre-configured by default", () => {
    expect(isPreConfigured()).toBe(false)
  })

  it("loads serverUrl from config.json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ serverUrl: "https://corp.example.com" }), { status: 200 })
    )
    await loadConfig()
    expect(isPreConfigured()).toBe(true)
    expect(getBaseUrl()).toBe("https://corp.example.com")
    vi.restoreAllMocks()
  })

  it("strips trailing slashes from serverUrl", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ serverUrl: "https://corp.example.com///" }), { status: 200 })
    )
    await loadConfig()
    expect(getBaseUrl()).toBe("https://corp.example.com")
    vi.restoreAllMocks()
  })

  it("pre-configured URL takes priority over localStorage", async () => {
    setBaseUrl("https://user-set.example.com")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ serverUrl: "https://corp.example.com" }), { status: 200 })
    )
    await loadConfig()
    expect(getBaseUrl()).toBe("https://corp.example.com")
    vi.restoreAllMocks()
  })

  it("stays unconfigured when config.json is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }))
    await loadConfig()
    expect(isPreConfigured()).toBe(false)
    vi.restoreAllMocks()
  })

  it("stays unconfigured when config.json has no serverUrl", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 })
    )
    await loadConfig()
    expect(isPreConfigured()).toBe(false)
    vi.restoreAllMocks()
  })

  it("stays unconfigured when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"))
    await loadConfig()
    expect(isPreConfigured()).toBe(false)
    vi.restoreAllMocks()
  })

  it("resetConfig clears pre-configured state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ serverUrl: "https://corp.example.com" }), { status: 200 })
    )
    await loadConfig()
    expect(isPreConfigured()).toBe(true)
    resetConfig()
    expect(isPreConfigured()).toBe(false)
    vi.restoreAllMocks()
  })
})
