import { describe, it, expect, afterEach, vi } from "vitest"
import { NativeError, isNativeApp, nativeCall, nativeOn, nativePlatform } from "./native"

const g = globalThis as Record<string, unknown>

afterEach(() => {
  delete g.webkit
  delete g.rcNativePort
})

describe("native bridge", () => {
  it("is not native in a browser", async () => {
    expect(nativePlatform()).toBeNull()
    expect(isNativeApp()).toBe(false)
    await expect(nativeCall("signIn")).rejects.toMatchObject({ code: "failed" })
  })

  it("calls the iOS message handler and resolves with its reply", async () => {
    const postMessage = vi.fn(async () => ({ url: "com.opencode.rc:/auth/callback?code=x" }))
    g.webkit = { messageHandlers: { rcNative: { postMessage } } }
    expect(nativePlatform()).toBe("ios")
    expect(await nativeCall("signIn", { url: "https://idp/" })).toEqual({ url: "com.opencode.rc:/auth/callback?code=x" })
    expect(postMessage).toHaveBeenCalledWith({ method: "signIn", args: { url: "https://idp/" } })
  })

  it("turns an iOS error string into a NativeError", async () => {
    g.webkit = { messageHandlers: { rcNative: { postMessage: async () => Promise.reject(new Error("cancelled: closed by user")) } } }
    const err = (await nativeCall("signIn").catch((e) => e)) as NativeError
    expect(err).toBeInstanceOf(NativeError)
    expect(err.code).toBe("cancelled")
    expect(err.message).toBe("closed by user")
  })

  it("matches Android replies to calls by id", async () => {
    const sent: string[] = []
    const port: { postMessage: (m: string) => void; onmessage: ((e: { data: string }) => void) | null } = {
      postMessage: (m) => sent.push(m),
      onmessage: null,
    }
    g.rcNativePort = port
    expect(nativePlatform()).toBe("android")
    const a = nativeCall("signIn", { url: "https://a/" })
    const b = nativeCall("signIn", { url: "https://b/" })
    const [ma, mb] = sent.map((s) => JSON.parse(s))
    expect(ma).toMatchObject({ method: "signIn", args: { url: "https://a/" } })
    port.onmessage!({ data: JSON.stringify({ id: mb.id, error: { code: "cancelled", message: "superseded" } }) })
    port.onmessage!({ data: JSON.stringify({ id: ma.id, result: { url: "u" } }) })
    expect(await a).toEqual({ url: "u" })
    await expect(b).rejects.toMatchObject({ code: "cancelled", message: "superseded" })
  })

  it("delivers events from both shells", () => {
    const seen: unknown[] = []
    const port = { postMessage: () => {}, onmessage: null as ((e: { data: string }) => void) | null }
    g.rcNativePort = port
    const off = nativeOn("ws.open", (d) => seen.push(d))
    ;(g.__rcNativeEmit as (e: string, d: unknown) => void)("ws.open", { id: "1" })
    port.onmessage!({ data: JSON.stringify({ event: "ws.open", data: { id: "2" } }) })
    off()
    ;(g.__rcNativeEmit as (e: string, d: unknown) => void)("ws.open", { id: "3" })
    expect(seen).toEqual([{ id: "1" }, { id: "2" }])
  })
})
