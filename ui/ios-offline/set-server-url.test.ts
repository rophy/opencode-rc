// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./set-server-url.sh", import.meta.url))
const ios = fileURLToPath(new URL("../ios/App/", import.meta.url))
const CSP = `default-src 'self'; connect-src 'self' data: https://rc-placeholder.invalid wss://rc-placeholder.invalid; object-src 'none'`

let root: string
const pub = (...p: string[]) => path.join(root, "App", "App", "public", ...p)
const pbx = () => path.join(root, "App", "App.xcodeproj", "project.pbxproj")
const run = (...args: string[]) => spawnSync("sh", [path.join(root, "set-server-url.sh"), ...args], { encoding: "utf8" })
const bundleIds = () =>
  [...fs.readFileSync(pbx(), "utf8").matchAll(/PRODUCT_BUNDLE_IDENTIFIER = (.*);/g)].map((m) => m[1])

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-bundle-"))
  fs.mkdirSync(pub("assets"), { recursive: true })
  fs.mkdirSync(pub("v2", "assets"), { recursive: true })
  for (const f of [pub("index.html"), pub("v2", "index.html")])
    fs.writeFileSync(f, `<meta http-equiv="Content-Security-Policy" content="${CSP.replaceAll("'", "&#39;")}">`)
  for (const f of [pub("assets", "index-a.js"), pub("v2", "assets", "index-b.js")])
    fs.writeFileSync(f, `const c={serverUrl:\`https://rc-placeholder.invalid\`,features:{}}`)
  fs.writeFileSync(pub("assets", "other.js"), "const x=1")
  fs.mkdirSync(path.dirname(pbx()))
  fs.copyFileSync(path.join(ios, "App.xcodeproj", "project.pbxproj"), pbx())
  fs.copyFileSync(script, path.join(root, "set-server-url.sh"))
})

describe("set-server-url.sh", () => {
  it("sets an https server in the config and the CSP", () => {
    const r = run("https://rc.example.com:8443")
    expect(r.status, r.stderr).toBe(0)
    const html = fs.readFileSync(pub("index.html"), "utf8")
    expect(html).toContain("https://rc.example.com:8443 wss://rc.example.com:8443;")
    expect(fs.readFileSync(pub("v2", "assets", "index-b.js"), "utf8")).toContain("`https://rc.example.com:8443`")
    for (const f of [pub("index.html"), pub("v2", "index.html"), pub("assets", "index-a.js"), pub("v2", "assets", "index-b.js")])
      expect(fs.readFileSync(f, "utf8")).not.toContain("rc-placeholder.invalid")
  })

  it("uses ws: for an http server", () => {
    expect(run("http://10.0.0.5:12029").status).toBe(0)
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("http://10.0.0.5:12029 ws://10.0.0.5:12029;")
  })

  it("accepts a trailing slash", () => {
    expect(run("https://rc.example.com/").status).toBe(0)
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("https://rc.example.com wss://rc.example.com;")
  })

  it.each(["", "rc.example.com", "ftp://rc.example.com", "https://rc.example.com/api", "https://rc.example.com?x=1", "https://u@rc.example.com"])(
    "rejects %j and changes nothing",
    (url) => {
      const r = run(url)
      expect(r.status).toBe(2)
      expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("rc-placeholder.invalid")
    },
  )

  it("refuses a second run", () => {
    expect(run("https://rc.example.com").status).toBe(0)
    const r = run("https://other.example.com")
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already set/)
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("https://rc.example.com")
  })

  it("sets the bundle id with the server", () => {
    expect(bundleIds()).toEqual([
      "com.opencode.rc.tests", "com.opencode.rc", "com.opencode.rc", "com.opencode.rc.tests", "com.opencode.rc.uitests", "com.opencode.rc.uitests",
    ])
    const r = run("--bundle-id", "com.corp.open-code", "https://rc.example.com")
    expect(r.status, r.stderr).toBe(0)
    expect(bundleIds()).toEqual([
      '"com.corp.open-code.tests"', '"com.corp.open-code"', '"com.corp.open-code"',
      '"com.corp.open-code.tests"', '"com.corp.open-code.uitests"', '"com.corp.open-code.uitests"',
    ])
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("https://rc.example.com wss://rc.example.com;")
  })

  it("sets the bundle id alone, and again", () => {
    expect(run("--bundle-id", "com.corp.a").status).toBe(0)
    const r = run("--bundle-id", "com.corp.b")
    expect(r.status, r.stderr).toBe(0)
    expect(bundleIds()).toEqual([
      '"com.corp.b.tests"', '"com.corp.b"', '"com.corp.b"', '"com.corp.b.tests"', '"com.corp.b.uitests"', '"com.corp.b.uitests"',
    ])
    expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("rc-placeholder.invalid")
  })

  it("sets the bundle id after the server", () => {
    expect(run("https://rc.example.com").status).toBe(0)
    expect(run("--bundle-id", "com.corp.a").status).toBe(0)
    expect(bundleIds()[1]).toBe('"com.corp.a"')
  })

  it("gives the unit tests <id>.tests", () => {
    expect(run("--bundle-id", "com.corp.opencode").status).toBe(0)
    expect(bundleIds()).toContain('"com.corp.opencode.tests"')
    expect(bundleIds()).toContain('"com.corp.opencode.uitests"')
  })

  it("rejects an id that ends in .tests", () => {
    expect(run("--bundle-id", "com.corp.tests").status).toBe(2)
  })

  it.each(["", "opencode", "com.corp.", ".com.corp", "com..corp", "com.corp.open code", "com.corp_x", "com.corp/x", "com.corp.uitests"])(
    "rejects bundle id %j and changes nothing",
    (id) => {
      const before = fs.readFileSync(pbx(), "utf8")
      const r = run("--bundle-id", id, "https://rc.example.com")
      expect(r.status).toBe(2)
      expect(fs.readFileSync(pbx(), "utf8")).toBe(before)
      expect(fs.readFileSync(pub("index.html"), "utf8")).toContain("rc-placeholder.invalid")
    },
  )

  it("rejects --bundle-id with no value and unknown options", () => {
    expect(run("--bundle-id").status).toBe(2)
    expect(run("--bundle", "com.corp.a").status).toBe(2)
    expect(run("https://a.example.com", "https://b.example.com").status).toBe(2)
  })

  it("changes nothing when the server cannot be set", () => {
    expect(run("https://rc.example.com").status).toBe(0)
    const before = fs.readFileSync(pbx(), "utf8")
    const r = run("--bundle-id", "com.corp.a", "https://other.example.com")
    expect(r.status).toBe(1)
    expect(fs.readFileSync(pbx(), "utf8")).toBe(before)
  })

  it("refuses a server in a bundle with no placeholder", () => {
    for (const f of [pub("index.html"), pub("v2", "index.html"), pub("assets", "index-a.js"), pub("v2", "assets", "index-b.js")])
      fs.writeFileSync(f, "const c={serverUrl:void 0}")
    const r = run("https://rc.example.com")
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/placeholder not found/)
    expect(run("--bundle-id", "com.corp.a").status).toBe(0)
  })
})
