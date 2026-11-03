import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  isNativeApp: () => true,
  nativeCall: call,
}))

import { NativeError } from "./native"
import { REFRESH_KEY, login, resetAuthState } from "./auth"
import { resetConfig } from "./server"
import { resetProtocolState } from "./protocol"

const appConfig = {
  authorizationEndpoint: "https://idp.example.com/authorize",
  clientId: "opencode-rc-app",
  redirectUri: "com.opencode.rc:/auth/callback",
  prompt: "select_account",
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// Answers like the IdP: the callback carries the state from the authorization URL.
function idpReturns(params: Record<string, string>, opts: { keepState?: boolean } = { keepState: true }) {
  call.mockImplementation(async (_method: string, args: { url: string }) => {
    const state = new URL(args.url).searchParams.get("state")!
    const q = new URLSearchParams({ ...(opts.keepState ? { state } : { state: "other" }), ...params })
    return { url: `com.opencode.rc:/auth/callback?${q}` }
  })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetConfig()
  resetAuthState()
  resetProtocolState()
  call.mockReset()
  localStorage.setItem("opencode-rc-endpoint", "https://rc.example.com")
})

afterEach(() => vi.restoreAllMocks())

describe("app sign-in", () => {
  it("signs in at the IdP as the public client and exchanges the code with the verifier", async () => {
    idpReturns({ code: "abc+1" })
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(appConfig))
      .mockResolvedValueOnce(json({ access_token: "a", refresh_token: "r", expires_in: 900 }))

    expect(await login()).toBe("ok")

    expect(fetchSpy.mock.calls[0][0]).toBe("https://rc.example.com/auth/app-config")
    const [method, args] = call.mock.calls[0]
    expect(method).toBe("signIn")
    expect(args.callbackScheme).toBe("com.opencode.rc")
    const u = new URL(args.url)
    expect(u.origin + u.pathname).toBe("https://idp.example.com/authorize")
    expect(u.searchParams.get("response_type")).toBe("code")
    expect(u.searchParams.get("client_id")).toBe("opencode-rc-app")
    expect(u.searchParams.get("redirect_uri")).toBe("com.opencode.rc:/auth/callback")
    expect(u.searchParams.get("scope")).toBe("openid email profile")
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get("prompt")).toBe("select_account")
    const nonce = u.searchParams.get("nonce")
    expect(nonce).toBeTruthy()

    const [tokenUrl, init] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect(tokenUrl).toBe("https://rc.example.com/auth/app-token")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ code: "abc+1", code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), nonce })
    expect(localStorage.getItem(REFRESH_KEY)).toBe("r")
    expect(sessionStorage.length).toBe(0)
  })

  it("reports cancelled when the user closes the browser view", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    call.mockRejectedValue(new NativeError("cancelled", "closed"))
    expect(await login()).toBe("cancelled")
  })

  it("reports failed on a bridge error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    call.mockRejectedValue(new NativeError("failed", "no browser"))
    expect(await login()).toBe("failed")
  })

  it("reports unsupported when the server has no app sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "not_found" }, 404))
    expect(await login()).toBe("unsupported")
    expect(call).not.toHaveBeenCalled()
  })

  it("reports failed when the app config cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "boom" }, 500))
    expect(await login()).toBe("failed")
    expect(call).not.toHaveBeenCalled()
  })

  it("reports failed on a state mismatch without exchanging the code", async () => {
    idpReturns({ code: "abc" }, { keepState: false })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    expect(await login()).toBe("failed")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("reports failed when the IdP returns an error", async () => {
    idpReturns({ error: "access_denied" })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    expect(await login()).toBe("failed")
  })

  it("reports failed when the code exchange is rejected", async () => {
    idpReturns({ code: "abc" })
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(appConfig))
      .mockResolvedValueOnce(json({ error: "invalid_grant" }, 400))
    expect(await login()).toBe("failed")
  })

  it("reports failed without a configured server", async () => {
    localStorage.removeItem("opencode-rc-endpoint")
    expect(await login()).toBe("failed")
  })
})
