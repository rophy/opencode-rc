import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { installProxyXHR } from "./proxy-fetch"

const opts = { pageOrigin: "https://ui.example", serverOrigin: "https://rc.example", sessionId: "abc" }
const proto = XMLHttpRequest.prototype
const originals = { open: proto.open, send: proto.send, setRequestHeader: proto.setRequestHeader, abort: proto.abort }

// jsdom's XHR would hit the network: replace the prototype methods with recorders first, so the
// shim wraps them.
let opened: Array<[string, string]>
let headers: Array<[string, string]>
let sent: number

beforeEach(() => {
  opened = []
  headers = []
  sent = 0
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    opened.push([method, String(url)])
    Object.defineProperty(this, "readyState", { value: 1, configurable: true })
  } as typeof proto.open
  proto.setRequestHeader = function (name: string, value: string) {
    headers.push([name, value])
  }
  proto.send = function () {
    sent++
  }
  // Like a browser: abort() on an OPENED request that was not sent leaves it OPENED.
  proto.abort = function () {}
})

afterEach(() => {
  Object.assign(proto, originals)
})

const flush = () => new Promise((r) => setTimeout(r, 0))
const uploadUrl = () => new URL("/api/experimental/fs/write?path=%2Ftmp%2Fu%2Ff", "https://ui.example/proxy/abc/")

describe("installProxyXHR", () => {
  it("routes a same-origin request through the proxy with the bearer token", async () => {
    installProxyXHR({ ...opts, getToken: async () => "tok" })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    xhr.send(new Blob(["x"]))
    expect(sent).toBe(0)
    await flush()
    expect(opened).toEqual([["POST", "https://rc.example/proxy/abc/api/experimental/fs/write?path=%2Ftmp%2Fu%2Ff"]])
    expect(headers).toEqual([["authorization", "Bearer tok"]])
    expect(sent).toBe(1)
  })

  it("leaves a cross-origin request untouched and sends it at once", () => {
    const getToken = vi.fn(async () => "tok")
    installProxyXHR({ ...opts, getToken })
    const xhr = new XMLHttpRequest()
    xhr.open("GET", "https://other.example/x")
    xhr.send()
    expect(opened).toEqual([["GET", "https://other.example/x"]])
    expect(sent).toBe(1)
    expect(getToken).not.toHaveBeenCalled()
    expect(headers).toEqual([])
  })

  it("does not send a request aborted before the token resolves", async () => {
    installProxyXHR({ ...opts, getToken: async () => "tok" })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    xhr.send()
    xhr.abort()
    await flush()
    expect(sent).toBe(0)
    expect(headers).toEqual([])
  })

  it("fires abort and loadend when aborted during the token wait", async () => {
    installProxyXHR({ ...opts, getToken: async () => "tok" })
    const xhr = new XMLHttpRequest()
    const events: string[] = []
    for (const t of ["abort", "error", "load", "loadend"]) xhr.addEventListener(t, () => events.push(t))
    const upload: string[] = []
    xhr.upload.addEventListener("abort", () => upload.push("abort"))
    xhr.open("POST", uploadUrl())
    xhr.send()
    xhr.abort()
    await flush()
    expect(events).toEqual(["abort", "loadend"])
    expect(upload).toEqual(["abort"])
    expect(sent).toBe(0)
  })

  it("fires no events when aborting a request that was not waiting", () => {
    installProxyXHR({ ...opts, getToken: async () => "tok" })
    const xhr = new XMLHttpRequest()
    const events: string[] = []
    xhr.addEventListener("abort", () => events.push("abort"))
    xhr.open("POST", uploadUrl())
    xhr.abort()
    expect(events).toEqual([])
  })

  it("sends without a header when the token lookup fails", async () => {
    installProxyXHR({
      ...opts,
      getToken: async () => {
        throw new Error("no token")
      },
    })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    xhr.send()
    await flush()
    expect(headers).toEqual([])
    expect(sent).toBe(1)
  })

  it("calls onForbidden on a 403 response", async () => {
    const onForbidden = vi.fn()
    installProxyXHR({ ...opts, getToken: async () => "tok", onForbidden })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    Object.defineProperty(xhr, "status", { value: 403 })
    xhr.dispatchEvent(new Event("loadend"))
    expect(onForbidden).toHaveBeenCalledTimes(1)
  })

  it("does not call onForbidden on success", () => {
    const onForbidden = vi.fn()
    installProxyXHR({ ...opts, getToken: async () => "tok", onForbidden })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    Object.defineProperty(xhr, "status", { value: 200 })
    xhr.dispatchEvent(new Event("loadend"))
    expect(onForbidden).not.toHaveBeenCalled()
  })

  it("drops the token when the instance is re-opened on a non-proxied URL", async () => {
    installProxyXHR({ ...opts, getToken: async () => "tok" })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    xhr.open("GET", "https://other.example/x")
    xhr.send()
    await flush()
    expect(opened[1]).toEqual(["GET", "https://other.example/x"])
    expect(headers).toEqual([])
    expect(sent).toBe(1)
  })

  it("is idempotent: a second install replaces the options without stacking", async () => {
    const forbiddenA = vi.fn()
    const forbiddenB = vi.fn()
    installProxyXHR({ ...opts, getToken: async () => "A", onForbidden: forbiddenA })
    installProxyXHR({ ...opts, sessionId: "B", getToken: async () => "B", onForbidden: forbiddenB })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", new URL("/api/x", "https://ui.example/proxy/B/"))
    xhr.send()
    await flush()
    expect(opened).toEqual([["POST", "https://rc.example/proxy/B/api/x"]])
    expect(headers).toEqual([["authorization", "Bearer B"]])
    expect(sent).toBe(1)
    Object.defineProperty(xhr, "status", { value: 403 })
    xhr.dispatchEvent(new Event("loadend"))
    expect(forbiddenA).not.toHaveBeenCalled()
    expect(forbiddenB).toHaveBeenCalledTimes(1)
  })

  it("calls onForbidden once even if the instance is opened twice", () => {
    const onForbidden = vi.fn()
    installProxyXHR({ ...opts, getToken: async () => "tok", onForbidden })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    xhr.open("POST", uploadUrl())
    Object.defineProperty(xhr, "status", { value: 403 })
    xhr.dispatchEvent(new Event("loadend"))
    expect(onForbidden).toHaveBeenCalledTimes(1)
  })

  it("ignores 403 after re-opening on a non-proxied URL", () => {
    const onForbidden = vi.fn()
    installProxyXHR({ ...opts, getToken: async () => "tok", onForbidden })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    xhr.open("GET", "https://other.example/x")
    Object.defineProperty(xhr, "status", { value: 403 })
    xhr.dispatchEvent(new Event("loadend"))
    expect(onForbidden).not.toHaveBeenCalled()
  })

  it("drops an Authorization header the app sets on a proxied request", async () => {
    installProxyXHR({ ...opts, getToken: async () => "tok" })
    const xhr = new XMLHttpRequest()
    xhr.open("POST", uploadUrl())
    xhr.setRequestHeader("Authorization", "Basic abc")
    xhr.setRequestHeader("content-type", "text/plain")
    xhr.send()
    await flush()
    expect(headers).toEqual([
      ["content-type", "text/plain"],
      ["authorization", "Bearer tok"],
    ])
  })

  it("leaves a non-proxied request's Authorization header alone", () => {
    installProxyXHR({ ...opts, getToken: async () => "tok" })
    const xhr = new XMLHttpRequest()
    xhr.open("GET", "https://other.example/x")
    xhr.setRequestHeader("Authorization", "Basic abc")
    expect(headers).toEqual([["Authorization", "Basic abc"]])
  })

  it("leaves a synchronous request untouched", () => {
    const getToken = vi.fn(async () => "tok")
    installProxyXHR({ ...opts, getToken })
    const xhr = new XMLHttpRequest()
    xhr.open("GET", uploadUrl(), false)
    xhr.send()
    expect(opened).toEqual([["GET", uploadUrl().href]])
    expect(sent).toBe(1)
    expect(getToken).not.toHaveBeenCalled()
  })
})
