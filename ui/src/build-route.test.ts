import { describe, expect, test } from "vitest"
import { bounceTarget, restoredPath } from "./build-route"

const enc = "%2Fv2%2Fs%2Fa%2F%3Fx%3D1%23h"

describe("bounceTarget", () => {
  test("1.x on a /v2/ path bounces to the 2.x index file", () => {
    expect(bounceTarget("", { pathname: "/v2/s/a/", search: "?x=1", hash: "#h" })).toBe(`/v2/index.html?rc_path=${enc}`)
  })
  test("other paths and builds do not bounce", () => {
    expect(bounceTarget("", { pathname: "/s/a/", search: "", hash: "" })).toBeNull()
    expect(bounceTarget("", { pathname: "/v2", search: "", hash: "" })).toBeNull()
    expect(bounceTarget("", { pathname: "/", search: "", hash: "" })).toBeNull()
    expect(bounceTarget("", { pathname: "/v2/index.html", search: "?rc_path=%2Fv2%2Fs%2Fa%2F", hash: "" })).toBeNull()
    expect(bounceTarget("/v2", { pathname: "/v2/s/a/", search: "", hash: "" })).toBeNull()
  })
})

describe("restoredPath", () => {
  const at = (rc: string) => ({ pathname: "/v2/index.html", search: `?rc_path=${rc}` })
  test("restores the original /v2/ path", () => {
    expect(restoredPath("/v2", at(enc))).toBe("/v2/s/a/?x=1#h")
  })
  test("ignores anything outside /v2/", () => {
    expect(restoredPath("/v2", at(encodeURIComponent("//evil.example/x")))).toBeNull()
    expect(restoredPath("/v2", at(encodeURIComponent("https://evil/x")))).toBeNull()
    expect(restoredPath("/v2", at(encodeURIComponent("/s/a/")))).toBeNull()
  })
  test("only the 2.x build at its index file", () => {
    expect(restoredPath("", at(enc))).toBeNull()
    expect(restoredPath("/v2", { pathname: "/v2/s/a/", search: `?rc_path=${enc}` })).toBeNull()
    expect(restoredPath("/v2", { pathname: "/v2/index.html", search: "" })).toBeNull()
  })
})
