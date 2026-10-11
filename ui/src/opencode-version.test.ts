import { describe, it, expect } from "vitest"
import { isV1Session, sessionPath, mismatchRedirect } from "./opencode-version"

describe("isV1Session", () => {
  it("treats missing and 1.x as 1.x", () => {
    expect(isV1Session(undefined)).toBe(true)
    expect(isV1Session("")).toBe(true)
    expect(isV1Session("1.14.2")).toBe(true)
  })
  it("treats anything else as 2.x", () => {
    expect(isV1Session("2.0.0")).toBe(false)
    expect(isV1Session("10.1.0")).toBe(false)
    expect(isV1Session("11.0.0")).toBe(false)
    expect(isV1Session("x1.0")).toBe(false)
  })
})

describe("sessionPath", () => {
  it("routes by version", () => {
    expect(sessionPath({ id: "a", opencodeVersion: "1.2.3" })).toBe("/s/a/")
    expect(sessionPath({ id: "b" })).toBe("/s/b/")
    expect(sessionPath({ id: "c", opencodeVersion: "2.0.0" })).toBe("/v2/s/c/")
  })
  it("encodes the id", () => {
    expect(sessionPath({ id: "a/b c" })).toBe("/s/a%2Fb%20c/")
  })
})

describe("mismatchRedirect", () => {
  const loc = (base: string, rest = "/", search = "", hash = "") => ({
    base, id: "x", pathname: `${base}/s/x${rest}`, search, hash,
  })
  const v1 = [{ id: "x" }]
  const v2 = [{ id: "x", opencodeVersion: "2.0.0" }]

  it("sends a 2.x session loaded in the 1.x build to /v2, keeping the rest", () => {
    expect(mismatchRedirect(v2, loc("", "/abc/session/d", "?q=1", "#h"))).toBe("/v2/s/x/abc/session/d?q=1#h")
  })
  it("sends a 1.x session loaded in the 2.x build to /s", () => {
    expect(mismatchRedirect(v1, loc("/v2", "/abc", "?q=1"))).toBe("/s/x/abc?q=1")
  })
  it("does nothing when the build matches or the session is unknown", () => {
    expect(mismatchRedirect(v1, loc(""))).toBeNull()
    expect(mismatchRedirect(v2, loc("/v2"))).toBeNull()
    expect(mismatchRedirect([], loc(""))).toBeNull()
  })
  it("handles a path with no trailing part", () => {
    expect(mismatchRedirect(v2, { base: "", id: "x", pathname: "/s/x", search: "", hash: "" })).toBe("/v2/s/x/")
  })
})
