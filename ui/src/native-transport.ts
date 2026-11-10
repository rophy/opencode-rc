import { nativeCall, nativeOn } from "./native"

// iOS app: the WebView makes no network requests of its own. Requests to the server go to the
// app's scheme (opencode-rc://localhost/__server/...), which the shell forwards with URLSession
// (ui/ios/App/App/ServerProxy.swift); WebSockets go through the bridge (WebSocketBridge.swift).
// URLSession traffic is the app's own, so a per-app VPN carries it. Installed before the proxy
// patches (proxy-fetch.ts), which then build on these.
export const SERVER_PREFIX = "/__server"

function hostOf(url: URL): string {
  return `${url.protocol}//${url.host}`
}

export function transportUrl(input: string, server: string, pageBase: string): string | null {
  if (!server) return null
  let url: URL
  let target: URL
  try {
    url = new URL(input, `${pageBase}/`)
    target = new URL(server)
  } catch {
    return null
  }
  if (hostOf(url) !== hostOf(target)) return null
  return `${SERVER_PREFIX}${url.pathname}${url.search}`
}

function pageBase(): string {
  return `${location.protocol}//${location.host}`
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function encodeMessage(data: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<{ text: string } | { base64: string }> {
  if (typeof data === "string") return { text: data }
  if (data instanceof Blob) return { base64: bytesToBase64(new Uint8Array(await data.arrayBuffer())) }
  if (ArrayBuffer.isView(data)) return { base64: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) }
  return { base64: bytesToBase64(new Uint8Array(data as ArrayBuffer)) }
}

export function installNativeTransport(opts: { getServer: () => string }): void {
  let sentServer: string | null = null
  const syncServer = async () => {
    const server = opts.getServer()
    if (!server) return
    // Only protocol//host: the request path (base path included) is appended by the shell.
    const origin = hostOf(new URL(server))
    if (origin === sentServer) return
    await nativeCall("setServer", { origin })
    sentServer = origin
  }
  const map = (input: string) => transportUrl(input, opts.getServer(), pageBase())

  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const local = map(raw)
    if (!local) return originalFetch(input, init)
    await syncServer()
    const source = new Request(input instanceof Request ? input : new URL(raw, `${pageBase()}/`).href, init)
    const hasBody = source.method !== "GET" && source.method !== "HEAD"
    // Buffered, as in proxy-fetch.ts: WebKit does not stream request bodies.
    const body = hasBody ? await source.clone().arrayBuffer() : undefined
    const sent = originalFetch(
      new Request(`${pageBase()}${local}`, {
        method: source.method,
        headers: source.headers,
        body,
        signal: source.signal,
        redirect: source.redirect,
      }),
    )
    // WebKit does not reject an app-scheme fetch whose signal aborts before the response starts,
    // so reject it here, as fetch does elsewhere.
    const signal = source.signal
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
      sent.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
  }

  const proto = XMLHttpRequest.prototype
  const originalOpen = proto.open
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const local = map(String(url))
    if (local) void syncServer()
    return (originalOpen as (...a: unknown[]) => void).call(this, method, local ?? url, ...rest)
  } as typeof proto.open

  const g = globalThis as { EventSource?: new (url: string | URL, init?: EventSourceInit) => EventSource }
  if (g.EventSource) {
    const Original = g.EventSource
    g.EventSource = class extends Original {
      constructor(url: string | URL, init?: EventSourceInit) {
        const local = map(String(url))
        if (local) void syncServer()
        super(local ?? url, init)
      }
    }
  }

  globalThis.WebSocket = makeNativeWebSocket(syncServer) as unknown as typeof WebSocket
}

let socketCount = 0

function makeNativeWebSocket(syncServer: () => Promise<void>) {
  const sockets = new Map<string, NativeWebSocket>()
  nativeOn("ws.open", (d) => {
    const { id, protocol } = d as { id: string; protocol?: string }
    sockets.get(id)?.opened(protocol ?? "")
  })
  nativeOn("ws.message", (d) => {
    const m = d as { id: string; text?: string; base64?: string }
    sockets.get(m.id)?.received(m.text, m.base64)
  })
  nativeOn("ws.error", (d) => sockets.get((d as { id: string }).id)?.errored())
  nativeOn("ws.close", (d) => {
    const c = d as { id: string; code: number; reason: string; wasClean: boolean }
    const socket = sockets.get(c.id)
    sockets.delete(c.id)
    socket?.closed(c.code, c.reason, c.wasClean)
  })

  class NativeWebSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    readonly url: string
    readyState = 0
    protocol = ""
    extensions = ""
    bufferedAmount = 0
    binaryType: BinaryType = "blob"
    onopen: ((ev: Event) => unknown) | null = null
    onmessage: ((ev: MessageEvent) => unknown) | null = null
    onerror: ((ev: Event) => unknown) | null = null
    onclose: ((ev: CloseEvent) => unknown) | null = null
    private readonly id = `ws-${++socketCount}`
    private queue: Promise<unknown> = Promise.resolve()

    constructor(url: string | URL, protocols?: string | string[]) {
      super()
      this.url = String(url)
      sockets.set(this.id, this)
      const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
      this.queue = syncServer()
        .then(() => nativeCall("wsOpen", { id: this.id, url: this.url, protocols: list }))
        .catch(() => {
          this.errored()
          sockets.delete(this.id)
          this.closed(1006, "", false)
        })
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError")
      if (this.readyState !== 1) return
      this.queue = this.queue
        .then(() => encodeMessage(data))
        .then((msg) => nativeCall("wsSend", { id: this.id, ...msg }))
        .catch(() => {})
    }

    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return
      this.readyState = 2
      this.queue = this.queue.then(() => nativeCall("wsClose", { id: this.id, code, reason })).catch(() => {})
    }

    private fire(type: "open" | "message" | "error" | "close", ev: Event) {
      this.dispatchEvent(ev)
      const handler = this[`on${type}`] as ((ev: Event) => unknown) | null
      handler?.call(this, ev)
    }

    opened(protocol: string) {
      this.protocol = protocol
      this.readyState = 1
      this.fire("open", new Event("open"))
    }

    received(text?: string, base64?: string) {
      let data: unknown = text
      if (base64 !== undefined) {
        const bytes = base64ToBytes(base64)
        data = this.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes as BlobPart])
      }
      this.fire("message", new MessageEvent("message", { data }))
    }

    errored() {
      this.fire("error", new Event("error"))
    }

    closed(code: number, reason: string, wasClean: boolean) {
      this.readyState = 3
      this.fire("close", new CloseEvent("close", { code, reason, wasClean }))
    }
  }
  return NativeWebSocket
}
