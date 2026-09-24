export interface ProxyOptions {
  pageOrigin: string
  serverOrigin: string
  sessionId: string
}

// opencode-rc's own endpoints: never rewritten to the session proxy.
const RC_PREFIXES = ["/auth/", "/gateway/", "/assets/"]
const RC_PATHS = ["/healthz", "/api/me"]

export function proxyTarget(input: string, opts: ProxyOptions): string | null {
  let url: URL
  try {
    url = new URL(input, opts.pageOrigin)
  } catch {
    return null
  }
  if (url.origin !== opts.pageOrigin && url.origin !== opts.serverOrigin) return null
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

    // Build a plain RequestInit per attempt rather than passing a Request as
    // `init` (nesting Requests this way silently drops the body in some
    // fetch implementations). Cloning `input` per attempt keeps its body
    // stream reusable across the 401 retry.
    const buildRequest = (): Request => {
      if (input instanceof Request) {
        const src = input.clone()
        const hasBody = src.method !== "GET" && src.method !== "HEAD"
        return new Request(target, {
          method: src.method,
          headers: src.headers,
          body: hasBody ? src.body : undefined,
          credentials: src.credentials,
          redirect: src.redirect,
          signal: src.signal,
          ...(hasBody ? { duplex: "half" } : {}),
          ...init,
        } as RequestInit)
      }
      return new Request(target, init ? ({ ...init, duplex: "half" } as RequestInit) : init)
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
