import { describe, it, expect, beforeEach, vi } from "vitest"
import { getBaseUrl, setBaseUrl, apiUrl, isConfigured, fetchMe, fetchSessions } from "./api"

beforeEach(() => {
  localStorage.clear()
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

describe("fetchMe", () => {
  it("returns user info on success", async () => {
    const user = { sub: "alice", email: "alice@example.com", name: "Alice" }
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })
    )
    expect(await fetchMe()).toEqual(user)
    vi.restoreAllMocks()
  })

  it("returns null on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }))
    expect(await fetchMe()).toBeNull()
    vi.restoreAllMocks()
  })

  it("uses base URL when configured", async () => {
    setBaseUrl("https://rc.example.com")
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }))
    await fetchMe()
    expect(spy).toHaveBeenCalledWith("https://rc.example.com/api/me")
    vi.restoreAllMocks()
  })
})

describe("fetchSessions", () => {
  it("returns sessions on success", async () => {
    const sessions = [{ id: "s1", userID: "u1", endpoint: "e", directory: "/p", lastHeartbeat: "2026-01-01T00:00:00Z" }]
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(sessions), { status: 200, headers: { "content-type": "application/json" } })
    )
    expect(await fetchSessions()).toEqual(sessions)
    vi.restoreAllMocks()
  })

  it("returns empty array on error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }))
    expect(await fetchSessions()).toEqual([])
    vi.restoreAllMocks()
  })
})
