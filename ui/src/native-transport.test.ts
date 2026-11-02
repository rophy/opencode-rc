import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { SERVER_PREFIX, installNativeTransport, transportUrl } from "./native-transport"

const g = globalThis as Record<string, unknown>
const SERVER = "https://rc.example.com"
const PAGE = "opencode-rc://localhost"

describe("transportUrl", () => {
  it("maps requests to the server onto the local prefix", () => {
    expect(transportUrl("https://rc.example.com/api/me?x=1", SERVER, PAGE)).toBe("/__server/api/me?x=1")
    expect(transportUrl("https://rc.example.com", SERVER, PAGE)).toBe("/__server/")
  })
  it("leaves other targets alone", () => {
    expect(transportUrl("/assets/a.js", SERVER, PAGE)).toBeNull()
    expect(transportUrl("https://other.example.com/x", SERVER, PAGE)).toBeNull()
    expect(transportUrl("http://rc.example.com/x", SERVER, PAGE)).toBeNull()
    expect(transportUrl("https://rc.example.com/x", "", PAGE)).toBeNull()
  })
})

describe("installNativeTransport", () => {
  const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, open: XMLHttpRequest.prototype.open }
  let postMessage: ReturnType<typeof vi.fn>
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    postMessage = vi.fn(async () => null)
    g.webkit = { messageHandlers: { rcNative: { postMessage } } }
    fetchSpy = vi.fn(async () => new Response("ok"))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    installNativeTransport({ getServer: () => SERVER })
  })

  afterEach(() => {
    globalThis.fetch = originals.fetch
    globalThis.WebSocket = originals.WebSocket
    XMLHttpRequest.prototype.open = originals.open
    delete g.webkit
    delete g.EventSource
  })

  it("sends server requests to the local prefix with method, headers and body", async () => {
    await fetch("https://rc.example.com/proxy/s/message", {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: "hello",
    })
    expect(postMessage).toHaveBeenCalledWith({ method: "setServer", args: { origin: SERVER } })
    const req = fetchSpy.mock.calls[0][0] as Request
    expect(new URL(req.url).pathname).toBe(`${SERVER_PREFIX}/proxy/s/message`)
    expect(req.method).toBe("POST")
    expect(req.headers.get("authorization")).toBe("Bearer t")
    expect(await req.text()).toBe("hello")
  })

  it("sets the server once until it changes", async () => {
    await fetch("https://rc.example.com/a")
    await fetch("https://rc.example.com/b")
    expect(postMessage.mock.calls.filter(([m]) => m.method === "setServer")).toHaveLength(1)
  })

  it("passes bundle requests through unchanged", async () => {
    await fetch("/assets/app.js")
    expect(fetchSpy).toHaveBeenCalledWith("/assets/app.js", undefined)
  })

  it("maps XMLHttpRequest URLs", () => {
    const seen: string[] = []
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, _m: string, url: string | URL) {
      seen.push(String(url))
    } as typeof XMLHttpRequest.prototype.open
    installNativeTransport({ getServer: () => SERVER })
    new XMLHttpRequest().open("POST", "https://rc.example.com/api/experimental/fs/write")
    new XMLHttpRequest().open("GET", "/assets/a.json")
    expect(seen).toEqual(["/__server/api/experimental/fs/write", "/assets/a.json"])
  })

  it("maps EventSource URLs", () => {
    const created: string[] = []
    class FakeEventSource {
      constructor(url: string) {
        created.push(url)
      }
    }
    g.EventSource = FakeEventSource
    installNativeTransport({ getServer: () => SERVER })
    new (g.EventSource as new (url: string) => unknown)("https://rc.example.com/proxy/s/event")
    expect(created).toEqual(["/__server/proxy/s/event"])
  })

  it("opens WebSockets through the bridge and relays events", async () => {
    const ws = new WebSocket("wss://rc.example.com/proxy/s/pty/1?access_token=t")
    ws.binaryType = "arraybuffer"
    const events: string[] = []
    ws.onopen = () => events.push("open")
    ws.onmessage = (e) => events.push(typeof e.data === "string" ? `text:${e.data}` : `bin:${new Uint8Array(e.data)[0]}`)
    ws.onclose = (e) => events.push(`close:${e.code}`)
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([m]) => m.method === "wsOpen")).toBe(true))
    const open = postMessage.mock.calls.find(([m]) => m.method === "wsOpen")![0].args
    expect(open.url).toBe("wss://rc.example.com/proxy/s/pty/1?access_token=t")
    const emit = g.__rcNativeEmit as (e: string, d: unknown) => void
    emit("ws.open", { id: open.id, protocol: "" })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.send("ls")
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({ method: "wsSend", args: { id: open.id, text: "ls" } }),
    )
    emit("ws.message", { id: open.id, text: "hi" })
    emit("ws.message", { id: open.id, base64: "Kg==" })
    emit("ws.close", { id: open.id, code: 1000, reason: "", wasClean: true })
    expect(events).toEqual(["open", "text:hi", "bin:42", "close:1000"])
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})
