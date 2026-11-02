// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { iosCsp, syncMobile } from "./sync-mobile"

const META = `<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; connect-src &#39;self&#39; data: https://rc.example.com wss://rc.example.com; object-src &#39;none&#39;">`

describe("iosCsp", () => {
  it("allows connections only to the app itself", () => {
    expect(iosCsp(META)).toContain("connect-src &#39;self&#39; data:; object-src")
    expect(iosCsp(META)).not.toContain("rc.example.com")
  })
  it("leaves a page without a policy alone", () => {
    expect(iosCsp("<html></html>")).toBe("<html></html>")
  })
})

describe("syncMobile", () => {
  function dist() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-dist-"))
    fs.mkdirSync(path.join(root, "v2", "assets"), { recursive: true })
    fs.writeFileSync(path.join(root, "index.html"), META)
    fs.writeFileSync(path.join(root, "v2", "index.html"), META)
    fs.writeFileSync(path.join(root, "v2", "assets", "a.js"), "x")
    return root
  }

  it("replaces the destination and rewrites every index.html for iOS", () => {
    const src = dist()
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-dest-")), "public")
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, "stale.js"), "old")
    syncMobile("ios", src, dest)
    expect(fs.existsSync(path.join(dest, "stale.js"))).toBe(false)
    expect(fs.readFileSync(path.join(dest, "v2", "assets", "a.js"), "utf8")).toBe("x")
    for (const f of ["index.html", "v2/index.html"])
      expect(fs.readFileSync(path.join(dest, f), "utf8")).not.toContain("rc.example.com")
  })

  it("copies Android unchanged", () => {
    const src = dist()
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-dest-")), "public")
    syncMobile("android", src, dest)
    expect(fs.readFileSync(path.join(dest, "index.html"), "utf8")).toBe(META)
  })
})
