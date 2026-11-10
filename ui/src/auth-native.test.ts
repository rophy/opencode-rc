import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  isNativeApp: () => true,
  nativeCall: call,
}))

import { NativeError } from "./native"
import { PROXY_ERROR_HEADER, REFRESH_KEY, SIGN_IN_TIMEOUT_MS, login, resetAuthState } from "./auth"
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

// A request that never answers; it fails only when its signal aborts, as fetch does.
function hangs(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
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

  it("reports the bridge error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    call.mockRejectedValue(new NativeError("failed", "cannot show sign-in"))
    expect(await login()).toEqual({ failed: "Cannot open the sign-in page (cannot show sign-in)." })
  })

  it("reports unsupported when the server has no app sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "not_found" }, 404))
    expect(await login()).toBe("unsupported")
    expect(call).not.toHaveBeenCalled()
  })

  it("reports the status when the app config cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "boom" }, 500))
    expect(await login()).toEqual({
      failed: "Cannot read the sign-in settings: rc.example.com answered HTTP 500 (boom).",
    })
    expect(call).not.toHaveBeenCalled()
  })

  it("reports a server that is not the API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("<!doctype html>", { status: 200 }))
    expect(await login()).toEqual({ failed: "rc.example.com is not an opencode-rc API server. Check the server URL." })
    expect(call).not.toHaveBeenCalled()
  })

  it("reports a server that cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Load failed"))
    expect(await login()).toEqual({ failed: "Cannot reach rc.example.com. Check the network or VPN." })
  })

  it("reports the iOS shell's reason when it cannot reach the server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("The request timed out.", { status: 502, headers: { [PROXY_ERROR_HEADER]: "1" } }),
    )
    expect(await login()).toEqual({
      failed: "Cannot reach rc.example.com (The request timed out.). Check the network or VPN.",
    })
  })

  it("gives up on a server that does not answer", async () => {
    vi.useFakeTimers()
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(hangs)
      const result = login()
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS)
      expect(await result).toEqual({
        failed: "Cannot reach rc.example.com (no answer in 30 s). Check the network or VPN.",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a state mismatch without exchanging the code", async () => {
    idpReturns({ code: "abc" }, { keepState: false })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    expect(await login()).toEqual({ failed: "The sign-in reply does not match this sign-in." })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("reports the IdP's error and description", async () => {
    idpReturns({ error: "unauthorized_client", error_description: "Client not enabled for PKCE" })
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    expect(await login()).toEqual({
      failed: "The identity provider refused sign-in: unauthorized_client: Client not enabled for PKCE.",
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("reports a callback with no code", async () => {
    idpReturns({})
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig))
    expect(await login()).toEqual({ failed: "The identity provider sent no sign-in code." })
  })

  it("reports why the code exchange was rejected", async () => {
    idpReturns({ code: "abc" })
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(appConfig))
      .mockResolvedValueOnce(json({ error: "invalid_grant", error_description: "ID token: nonce mismatch" }, 400))
    expect(await login()).toEqual({
      failed: "The server did not accept the sign-in: rc.example.com answered HTTP 400 (invalid_grant: ID token: nonce mismatch).",
    })
  })

  it("reports a code exchange the server could not reach", async () => {
    idpReturns({ code: "abc" })
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(appConfig))
      .mockRejectedValueOnce(new TypeError("Load failed"))
    expect(await login()).toEqual({ failed: "Cannot reach rc.example.com. Check the network or VPN." })
  })

  it("gives up on a code exchange that gets no answer", async () => {
    idpReturns({ code: "abc" })
    vi.useFakeTimers()
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(appConfig)).mockImplementationOnce(hangs)
      const result = login()
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS)
      expect(await result).toEqual({
        failed: "Cannot reach rc.example.com (no answer in 30 s). Check the network or VPN.",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a missing server", async () => {
    localStorage.removeItem("opencode-rc-endpoint")
    expect(await login()).toEqual({ failed: "No server is set. Open Server settings." })
  })
})
