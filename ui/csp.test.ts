import { describe, it, expect } from "vitest"
import { contentSecurityPolicy } from "./csp"

describe("contentSecurityPolicy", () => {
  it("allows any API origin without a preset server", () => {
    expect(contentSecurityPolicy()).toContain("connect-src 'self' data: http: https: ws: wss:;")
  })

  it("narrows connect-src to the preset server's origin", () => {
    const csp = contentSecurityPolicy("https://rc-api.example.com/base")
    expect(csp).toContain("connect-src 'self' data: https://rc-api.example.com wss://rc-api.example.com;")
  })

  it("maps http to ws", () => {
    expect(contentSecurityPolicy("http://opencode-rc-api:8080")).toContain(
      "connect-src 'self' data: http://opencode-rc-api:8080 ws://opencode-rc-api:8080;",
    )
  })

  it("adds frame-ancestors only for the HTTP header", () => {
    expect(contentSecurityPolicy()).not.toContain("frame-ancestors")
    expect(contentSecurityPolicy(undefined, { frameAncestors: true })).toMatch(/; frame-ancestors 'none'$/)
  })

  it("keeps scripts limited to the bundle", () => {
    expect(contentSecurityPolicy()).toContain("script-src 'self' 'wasm-unsafe-eval';")
  })
})
