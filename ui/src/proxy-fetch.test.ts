import { describe, it, expect, vi, afterEach } from "vitest"
import { proxyTarget, proxySocketUrl, installProxyFetch, installProxyWebSocket } from "./proxy-fetch"

const app = { pageOrigin: "https://localhost", serverOrigin: "https://rc.example.com", sessionId: "alice-dev" }
const web = { pageOrigin: "https://rc.example.com", serverOrigin: "https://rc.example.com", sessionId: "alice-dev" }
const capacitorApp = { pageOrigin: "capacitor://localhost", serverOrigin: "https://rc.example.com", sessionId: "alice-dev" }

const realFetch = globalThis.fetch
const realWebSocket = globalThis.WebSocket
afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = realFetch
  globalThis.WebSocket = realWebSocket
})

describe("proxyTarget", () => {
  it("prefixes opencode paths on the server origin", () => {
    expect(proxyTarget("https://rc.example.com/session?x=1", web)).toBe(
      "https://rc.example.com/proxy/alice-dev/session?x=1",
    )
  })

  it("moves page-origin requests to the server (app)", () => {
    expect(proxyTarget("https://localhost/global/event", app)).toBe(
      "https://rc.example.com/proxy/alice-dev/global/event",
    )
    expect(proxyTarget("/api/session", app)).toBe("https://rc.example.com/proxy/alice-dev/api/session")
  })

  it("keeps an existing proxy prefix and collapses duplicate slashes", () => {
    expect(proxyTarget("https://rc.example.com/proxy/alice-dev//pty/1/connect", web)).toBe(
      "https://rc.example.com/proxy/alice-dev/pty/1/connect",
    )
  })

  it("leaves opencode-rc endpoints and other hosts alone", () => {
    expect(proxyTarget("https://rc.example.com/api/me", web)).toBeNull()
    expect(proxyTarget("https://rc.example.com/auth/refresh", web)).toBeNull()
    expect(proxyTarget("https://rc.example.com/gateway/sessions", web)).toBeNull()
    expect(proxyTarget("https://rc.example.com/healthz", web)).toBeNull()
    expect(proxyTarget("https://localhost/assets/app.js", app)).toBeNull()
    expect(proxyTarget("https://models.dev/api.json", web)).toBeNull()
  })

  it("does not treat /api/media as /api/me", () => {
    expect(proxyTarget("https://rc.example.com/api/media", web)).toBe(
      "https://rc.example.com/proxy/alice-dev/api/media",
    )
  })

  it("rewrites capacitor:// page-origin requests (iOS)", () => {
    // URL.origin is "null" for non-special schemes like capacitor:, so this
    // must be matched by protocol+host, not by comparing .origin directly.
    expect(proxyTarget("/global/event", capacitorApp)).toBe(
      "https://rc.example.com/proxy/alice-dev/global/event",
    )
    expect(proxyTarget("capacitor://localhost/global/event", capacitorApp)).toBe(
      "https://rc.example.com/proxy/alice-dev/global/event",
    )
  })
})

describe("proxySocketUrl", () => {
  it("rewrites terminal sockets and adds the token", () => {
    expect(
      proxySocketUrl("wss://rc.example.com/proxy/alice-dev//pty/p1/connect?cursor=0", web, "tok"),
    ).toBe("wss://rc.example.com/proxy/alice-dev/pty/p1/connect?cursor=0&access_token=tok")
  })

  it("maps the app's page origin to the server", () => {
    expect(proxySocketUrl("wss://localhost/pty/p1/connect", app, "tok")).toBe(
      "wss://rc.example.com/proxy/alice-dev/pty/p1/connect?access_token=tok",
    )
  })

  it("ignores other hosts", () => {
    expect(proxySocketUrl("wss://other.example.com/x", web, "tok")).toBeNull()
  })
})

describe("installProxyFetch", () => {
  it("adds the bearer header and retries once on 401", async () => {
    const calls: Request[] = []
    let status = 401
    const original = vi.fn(async (req: Request) => {
      calls.push(req)
      const res = new Response("{}", { status })
      status = 200
      return res
    })
    globalThis.fetch = original as unknown as typeof fetch
    let n = 0
    const invalidate = vi.fn()
    installProxyFetch({ ...web, getToken: async () => `tok-${++n}`, invalidate })

    const res = await fetch("https://rc.example.com/session", { method: "POST", body: "{\"a\":1}" })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("https://rc.example.com/proxy/alice-dev/session")
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok-1")
    expect(calls[1].headers.get("authorization")).toBe("Bearer tok-2")
    expect(await calls[1].text()).toBe("{\"a\":1}")
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it("passes other requests through untouched", async () => {
    const original = vi.fn(async () => new Response("ok"))
    globalThis.fetch = original as unknown as typeof fetch
    installProxyFetch({ ...web, getToken: async () => "tok", invalidate: () => {} })
    await fetch("https://rc.example.com/api/me")
    expect(original).toHaveBeenCalledWith("https://rc.example.com/api/me", undefined)
  })

  it("buffers a Request input's body once, so both attempts (and the retry) carry it without re-streaming", async () => {
    // opencode's SDK always calls fetch with a Request object. Streaming
    // request uploads (duplex: "half") aren't supported in WKWebView/Safari
    // or Firefox and fail in Chrome over HTTP/1.1, so the body must be read
    // into a buffer once up front and reused, rather than re-derived as a
    // fresh stream (via clone()) for every attempt.
    const calls: Request[] = []
    let status = 401
    const original = vi.fn(async (req: Request) => {
      calls.push(req)
      const res = new Response("{}", { status })
      status = 200
      return res
    })
    globalThis.fetch = original as unknown as typeof fetch
    let n = 0
    const invalidate = vi.fn()
    installProxyFetch({ ...web, getToken: async () => `tok-${++n}`, invalidate })

    const request = new Request("https://rc.example.com/session", { method: "POST", body: "{\"a\":1}" })
    const cloneSpy = vi.spyOn(request, "clone")
    const res = await fetch(request)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(await calls[0].text()).toBe("{\"a\":1}")
    expect(await calls[1].text()).toBe("{\"a\":1}")
    expect(invalidate).toHaveBeenCalledTimes(1)
    // The body is read once (via a single clone().arrayBuffer()) and reused for
    // the retry; a per-attempt clone()/stream implementation would call this twice.
    expect(cloneSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["a 403", [403], 1],
    ["a 403 after the 401 retry", [401, 403], 1],
    ["a 200", [200], 0],
    ["a 401 then a 200", [401, 200], 0],
  ])("reports %s to onForbidden", async (_name, statuses, calls) => {
    const queue = [...statuses]
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: queue.shift() })) as unknown as typeof fetch
    const onForbidden = vi.fn()
    installProxyFetch({ ...web, getToken: async () => "tok", invalidate: () => {}, onForbidden })
    await fetch("https://rc.example.com/global/event")
    expect(onForbidden).toHaveBeenCalledTimes(calls)
  })
})

describe("installProxyWebSocket", () => {
  class FakeSocket extends EventTarget {
    constructor(
      public url: string,
      public protocols?: string | string[],
    ) {
      super()
    }
  }

  it.each([
    [1008, 1],
    [1000, 0],
    [1006, 0],
  ])("reports a close with code %i to onForbidden %i time(s)", (code, calls) => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const onForbidden = vi.fn()
    installProxyWebSocket({ ...web, getCachedToken: () => "tok", warmToken: () => {}, onForbidden })
    const ws = new WebSocket("wss://rc.example.com/pty/p1/connect")
    expect((ws as unknown as FakeSocket).url).toBe("wss://rc.example.com/proxy/alice-dev/pty/p1/connect?access_token=tok")
    ws.dispatchEvent(Object.assign(new Event("close"), { code }))
    expect(onForbidden).toHaveBeenCalledTimes(calls)
  })
})

describe("proxyTarget in the 2.x build", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  it("does not proxy the build's own /v2/assets", async () => {
    vi.stubEnv("BASE_URL", "/v2/")
    vi.resetModules()
    const mod = await import("./proxy-fetch")
    expect(mod.proxyTarget("https://localhost/v2/assets/app.js", app)).toBeNull()
    expect(mod.proxyTarget("https://localhost/assets/app.js", app)).toBeNull()
    expect(mod.proxyTarget("https://localhost/v2x/assets/app.js", app)).not.toBeNull()
  })
})
