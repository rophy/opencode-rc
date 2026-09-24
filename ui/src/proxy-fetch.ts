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

export function installProxyFetch(
  opts: ProxyOptions & { getToken: () => Promise<string | null>; invalidate: () => void },
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
    const res = await send()
    if (res.status !== 401) return res
    opts.invalidate()
    return send()
  }
}

export function installProxyWebSocket(
  opts: ProxyOptions & { getCachedToken: () => string | null; warmToken: () => void },
): void {
  const Native = globalThis.WebSocket
  class ProxiedWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      const token = opts.getCachedToken()
      // No valid token cached: start a refresh so the terminal's reconnect gets one.
      if (!token) opts.warmToken()
      super(proxySocketUrl(String(url), opts, token) ?? url, protocols)
    }
  }
  globalThis.WebSocket = ProxiedWebSocket as typeof WebSocket
}
