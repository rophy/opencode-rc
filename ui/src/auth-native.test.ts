import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const { start } = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock("./system-auth", () => ({ SystemAuth: { start } }))
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => true },
}))

import { APP_CALLBACK, REFRESH_KEY, login, resetAuthState } from "./auth"
import { resetConfig } from "./server"
import { resetProtocolState } from "./protocol"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetConfig()
  resetAuthState()
  resetProtocolState()
  start.mockReset()
  localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
})

afterEach(() => vi.restoreAllMocks())

describe("native login", () => {
  it("signs in through the system browser and exchanges the code with the verifier", async () => {
    start.mockResolvedValue({ url: `${APP_CALLBACK}#code=abc%2B1` })
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ access_token: "a", refresh_token: "r", expires_in: 900 }))

    expect(await login()).toBe("ok")

    const { url, callbackScheme } = start.mock.calls[0][0]
    expect(callbackScheme).toBe("com.opencode.rc")
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe("https://rc.example.com/auth/start")
    expect(u.searchParams.get("return_to")).toBe("com.opencode.rc:/auth/done")
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const [tokenUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe("https://rc.example.com/auth/token")
    const body = JSON.parse(init.body as string)
    expect(body.code).toBe("abc+1")
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(localStorage.getItem(REFRESH_KEY)).toBe("r")
    // The verifier never leaves the app, not even into storage.
    expect(sessionStorage.length).toBe(0)
  })

  it("reports cancelled when the user closes the browser", async () => {
    start.mockRejectedValue(Object.assign(new Error("closed"), { code: "cancelled" }))
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await login()).toBe("cancelled")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports failed on a plugin error", async () => {
    start.mockRejectedValue(Object.assign(new Error("boom"), { code: "failed" }))
    expect(await login()).toBe("failed")
  })

  it("reports failed when the callback has no code", async () => {
    start.mockResolvedValue({ url: `${APP_CALLBACK}#error=access_denied` })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await login()).toBe("failed")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports failed when the code exchange is rejected", async () => {
    start.mockResolvedValue({ url: `${APP_CALLBACK}#code=abc` })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "invalid_grant" }, 400))
    expect(await login()).toBe("failed")
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()
  })

  it("reports failed without a configured server", async () => {
    localStorage.removeItem("opencode-rc-endpoint")
    expect(await login()).toBe("failed")
    expect(start).not.toHaveBeenCalled()
  })
})
