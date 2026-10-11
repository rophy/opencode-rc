export interface ProxyOptions {
  pageOrigin: string
  serverOrigin: string
  sessionId: string
}

// opencode-rc's own endpoints: never rewritten to the session proxy.
const RC_PREFIXES = ["/auth/", "/gateway/", "/assets/"]
const RC_PATHS = ["/healthz", "/api/me"]

// URL.origin is "null" for non-special schemes (e.g. capacitor:) per the WHATWG
// URL spec, so it can't be used to compare against pageOrigin/serverOrigin on
// iOS (capacitor://localhost). Compare protocol+host instead.
function originOf(input: string): string {
  const url = new URL(input)
  return `${url.protocol}//${url.host}`
}

export function proxyTarget(input: string, opts: ProxyOptions): string | null {
  let url: URL
  try {
    url = new URL(input, opts.pageOrigin)
  } catch {
    return null
  }
  const origin = originOf(url.href)
  if (origin !== originOf(opts.pageOrigin) && origin !== originOf(opts.serverOrigin)) return null
  if (RC_PATHS.includes(url.pathname) || RC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    return null
  }
  const prefix = `/proxy/${encodeURIComponent(opts.sessionId)}`
  let path = url.pathname.replace(/\/{2,}/g, "/")
  if (path !== prefix && !path.startsWith(`${prefix}/`)) path = `${prefix}${path}`
  return `${opts.serverOrigin}${path}${url.search}`
}

export function proxySocketUrl(input: string, opts: ProxyOptions, token: string | null): string | null {
  let url: URL
  try {
    url = new URL(input, opts.pageOrigin)
  } catch {
    return null
  }
  const httpUrl = new URL(url.href)
  if (url.protocol === "wss:") httpUrl.protocol = "https:"
  else if (url.protocol === "ws:") httpUrl.protocol = "http:"
  const target = proxyTarget(httpUrl.href, opts)
  if (!target) return null
  const out = new URL(target)
  out.protocol = out.protocol === "https:" ? "wss:" : "ws:"
  if (token) out.searchParams.set("access_token", token)
  return out.href
}

// onForbidden: a proxied request got 403, which may mean the access hook now denies the
// user. The caller asks /api/me to find out; guards (e.g. a disabled terminal) answer 403 too.
export function installProxyFetch(
  opts: ProxyOptions & {
    getToken: () => Promise<string | null>
    invalidate: () => void
    onForbidden?: () => void
  },
): void {
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const target = proxyTarget(raw, opts)
    if (!target) return original(input, init)

    const method = input instanceof Request ? input.method : (init?.method ?? "GET")
    const hasBody = method !== "GET" && method !== "HEAD"
    // Buffer the body once up front instead of streaming it (duplex: "half"):
    // streaming request uploads aren't supported in WKWebView/Safari/Firefox
    // and fail in Chrome over HTTP/1.1, and we need to resend the same body
    // on a 401 retry anyway. Reading via a throwaway Request also normalizes
    // string/Blob/FormData bodies into a plain ArrayBuffer.
    const body = hasBody
      ? await (input instanceof Request ? input.clone() : new Request(raw, init)).arrayBuffer()
      : undefined

    // Build a plain RequestInit per attempt rather than passing a Request as
    // `init` (nesting Requests this way silently drops the body in some
    // fetch implementations).
    const buildRequest = (): Request => {
      if (input instanceof Request) {
        return new Request(target, {
          method: input.method,
          headers: input.headers,
          body,
          credentials: input.credentials,
          redirect: input.redirect,
          signal: input.signal,
          ...init,
        } as RequestInit)
      }
      return new Request(target, { ...init, body } as RequestInit)
    }
    const send = async () => {
      const req = buildRequest()
      const token = await opts.getToken()
      if (token) req.headers.set("authorization", `Bearer ${token}`)
      return original(req)
    }
    let res = await send()
    if (res.status === 401) {
      opts.invalidate()
      res = await send()
    }
    if (res.status === 403) opts.onForbidden?.()
    return res
  }
}

// onForbidden: the API closed the socket with 1008 (policy violation), as it does when the
// access hook denies the user of an open terminal.
export function installProxyWebSocket(
  opts: ProxyOptions & { getCachedToken: () => string | null; warmToken: () => void; onForbidden?: () => void },
): void {
  const Native = globalThis.WebSocket
  class ProxiedWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      const token = opts.getCachedToken()
      // No valid token cached: start a refresh so the terminal's reconnect gets one.
      if (!token) opts.warmToken()
      super(proxySocketUrl(String(url), opts, token) ?? url, protocols)
      this.addEventListener("close", (e) => {
        if (e.code === 1008) opts.onForbidden?.()
      })
    }
  }
  globalThis.WebSocket = ProxiedWebSocket as typeof WebSocket
}

type XHROptions = ProxyOptions & { getToken: () => Promise<string | null>; onForbidden?: () => void }

// opencode 2.x uploads attachments with XMLHttpRequest (for progress events) to a root-relative
// /api/experimental/fs/write URL, which the fetch patch never sees. Rewrite proxied requests
// the same way and add the bearer token. send() waits for the token, so a request aborted in
// the meantime is not sent. No 401 retry: getToken already refreshes an expired token before
// it resolves.
//
// The prototype is patched once; later calls (SessionView mounts per session) only replace the
// active options, so wrappers never stack.
let activeXHR: XHROptions | null = null
let xhrPatch: { open: typeof XMLHttpRequest.prototype.open } | null = null

export function installProxyXHR(opts: XHROptions): void {
  activeXHR = opts
  const proto = XMLHttpRequest.prototype
  if (xhrPatch && proto.open === xhrPatch.open) return

  const originalOpen = proto.open
  const originalSend = proto.send
  const originalAbort = proto.abort
  const originalSetRequestHeader = proto.setRequestHeader
  const proxied = new WeakSet<XMLHttpRequest>() // opened with a rewritten URL
  const listening = new WeakSet<XMLHttpRequest>() // has the 403 listener
  const pending = new WeakSet<XMLHttpRequest>() // send() waiting for the token

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    pending.delete(this)
    // Synchronous XHR can't wait for a token; opencode doesn't use it, so leave it untouched.
    const target = rest[0] === false || !activeXHR ? null : proxyTarget(String(url), activeXHR)
    if (target) {
      proxied.add(this)
      if (!listening.has(this)) {
        listening.add(this)
        this.addEventListener("loadend", () => {
          if (proxied.has(this) && this.status === 403) activeXHR?.onForbidden?.()
        })
      }
    } else {
      proxied.delete(this)
    }
    return (originalOpen as (...args: unknown[]) => void).call(this, method, target ?? url, ...rest)
  } as typeof proto.open

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    // The bearer is set in send(); an app-set Authorization would be appended to it.
    if (proxied.has(this) && name.toLowerCase() === "authorization") return
    return originalSetRequestHeader.call(this, name, value)
  }

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (!proxied.has(this) || !activeXHR) return originalSend.call(this, body)
    pending.add(this)
    activeXHR
      .getToken()
      .catch(() => null)
      .then((token) => {
        // abort() before send has no effect on the request state, so check our own flag.
        if (!pending.delete(this) || this.readyState !== XMLHttpRequest.OPENED) return
        if (token) originalSetRequestHeader.call(this, "authorization", `Bearer ${token}`)
        originalSend.call(this, body)
      })
      .catch(() => {})
  }

  proto.abort = function (this: XMLHttpRequest) {
    pending.delete(this)
    return originalAbort.call(this)
  }

  xhrPatch = { open: proto.open }
}
