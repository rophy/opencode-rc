import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  isNativeApp: () => true,
  nativeCall: call,
}))

import { NativeError } from "./native"
import { APP_CALLBACK, PROXY_ERROR_HEADER, REFRESH_KEY, SIGN_IN_TIMEOUT_MS, login, resetAuthState } from "./auth"
import { resetConfig } from "./server"
import { resetProtocolState } from "./protocol"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// Answers like the server: the sign-in view ends at the app callback with this fragment.
function serverReturns(fragment: Record<string, string>) {
  call.mockResolvedValue({ url: `${APP_CALLBACK}#${new URLSearchParams(fragment)}` })
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
  it("signs in through the server and exchanges the login code with the verifier", async () => {
    serverReturns({ code: "abc+1" })
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ access_token: "a", refresh_token: "r", expires_in: 900 }))

    expect(await login()).toBe("ok")

    const [method, args] = call.mock.calls[0]
    expect(method).toBe("signIn")
    expect(args.callbackScheme).toBe("com.opencode.rc")
    const u = new URL(args.url)
    expect(u.origin + u.pathname).toBe("https://rc.example.com/auth/start")
    expect(u.searchParams.get("return_to")).toBe("com.opencode.rc:/auth/done")
    const challenge = u.searchParams.get("code_challenge")
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [tokenUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe("https://rc.example.com/auth/token")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ code: "abc+1", code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier)))
    expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe(challenge)
    expect(localStorage.getItem(REFRESH_KEY)).toBe("r")
    expect(sessionStorage.length).toBe(0)
  })

  it("reports cancelled when the user closes the sign-in view", async () => {
    call.mockRejectedValue(new NativeError("cancelled", "closed"))
    expect(await login()).toBe("cancelled")
  })

  it("reports why the sign-in page could not open", async () => {
    call.mockRejectedValue(new NativeError("failed", "A server with the specified hostname could not be found."))
    expect(await login()).toEqual({
      failed: "Cannot open the sign-in page (A server with the specified hostname could not be found.).",
    })
  })

  it("reports the server's reason when it could not complete the sign-in", async () => {
    serverReturns({ error: "access_denied", error_description: "the identity provider refused sign-in: access_denied" })
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await login()).toEqual({
      failed: "The server could not complete the sign-in (the identity provider refused sign-in: access_denied).",
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports a callback with no code", async () => {
    serverReturns({})
    expect(await login()).toEqual({ failed: "The server sent no sign-in code." })
  })

  it("reports why the code exchange was rejected", async () => {
    serverReturns({ code: "abc" })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "invalid_grant" }, 400))
    expect(await login()).toEqual({
      failed: "The server did not accept the sign-in: rc.example.com answered HTTP 400 (invalid_grant).",
    })
  })

  it("reports the iOS shell's reason when it cannot reach the server", async () => {
    serverReturns({ code: "abc" })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("The request timed out.", { status: 502, headers: { [PROXY_ERROR_HEADER]: "1" } }),
    )
    expect(await login()).toEqual({
      failed: "Cannot reach rc.example.com (The request timed out.). Check the network or VPN.",
    })
  })

  it("reports a code exchange that could not reach the server", async () => {
    serverReturns({ code: "abc" })
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Load failed"))
    expect(await login()).toEqual({ failed: "Cannot reach rc.example.com. Check the network or VPN." })
  })

  it("gives up on a code exchange that gets no answer", async () => {
    serverReturns({ code: "abc" })
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

  it("reports a missing server", async () => {
    localStorage.removeItem("opencode-rc-endpoint")
    expect(await login()).toEqual({ failed: "No server is set. Open Server settings." })
    expect(call).not.toHaveBeenCalled()
  })
})
