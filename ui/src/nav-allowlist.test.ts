import { describe, it, expect } from "vitest"
import { deriveAllowNavigation, hostAllowed } from "./nav-allowlist"

describe("deriveAllowNavigation", () => {
  it("allows the server host and the OIDC issuer host", () => {
    expect(
      deriveAllowNavigation({
        serverUrl: "https://rc.example.com",
        oidc: { issuer: "https://sso.example.com/realms/corp" },
      }),
    ).toEqual(["rc.example.com", "sso.example.com"])
  })

  it("lists a shared host once", () => {
    expect(
      deriveAllowNavigation({ serverUrl: "https://example.com/rc", oidc: { issuer: "https://example.com/sso" } }),
    ).toEqual(["example.com"])
  })

  it("ignores missing and malformed URLs", () => {
    expect(deriveAllowNavigation({})).toEqual([])
    expect(deriveAllowNavigation(undefined)).toEqual([])
    expect(deriveAllowNavigation({ serverUrl: "not a url", oidc: { issuer: "https://sso.example.com" } })).toEqual([
      "sso.example.com",
    ])
  })
})

// Mirrors Capacitor's allowNavigation matching on iOS and Android.
describe("hostAllowed", () => {
  const list = ["api.example.com", "*.idp.example.com"]

  it("matches exact hosts case-insensitively", () => {
    expect(hostAllowed("API.example.com", list)).toBe(true)
  })

  it("lets * match exactly one label", () => {
    expect(hostAllowed("login.idp.example.com", list)).toBe(true)
    expect(hostAllowed("idp.example.com", list)).toBe(false)
    expect(hostAllowed("a.login.idp.example.com", list)).toBe(false)
  })

  it("rejects other hosts and look-alikes", () => {
    expect(hostAllowed("example.com", list)).toBe(false)
    expect(hostAllowed("api.example.com.evil.com", list)).toBe(false)
  })

  it("allows everything for a bare *", () => {
    expect(hostAllowed("anything.test", ["*"])).toBe(true)
  })

  it("allows nothing for an empty list", () => {
    expect(hostAllowed("api.example.com", [])).toBe(false)
  })
})
