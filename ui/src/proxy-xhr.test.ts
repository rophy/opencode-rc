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
  proto.abort = function (this: XMLHttpRequest) {
    Object.defineProperty(this, "readyState", { value: 0, configurable: true })
  }
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
})
