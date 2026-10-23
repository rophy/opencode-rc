// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./set-server-url.sh", import.meta.url))
const CSP = `default-src 'self'; connect-src 'self' data: https://rc-placeholder.invalid wss://rc-placeholder.invalid; object-src 'none'`

let root: string
const pub = (...p: string[]) => path.join(root, "App", "App", "public", ...p)
const run = (url: string) => spawnSync("sh", [path.join(root, "set-server-url.sh"), url], { encoding: "utf8" })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-bundle-"))
  fs.mkdirSync(pub("assets"), { recursive: true })
  fs.mkdirSync(pub("v2", "assets"), { recursive: true })
  for (const f of [pub("index.html"), pub("v2", "index.html")])
    fs.writeFileSync(f, `<meta http-equiv="Content-Security-Policy" content="${CSP.replaceAll("'", "&#39;")}">`)
  for (const f of [pub("assets", "index-a.js"), pub("v2", "assets", "index-b.js")])
    fs.writeFileSync(f, `const c={serverUrl:\`https://rc-placeholder.invalid\`,features:{}}`)
  fs.writeFileSync(pub("assets", "other.js"), "const x=1")
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
})
