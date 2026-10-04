import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyRewrites, featureRewrites, type Rewrite } from "./feature-rewrites"

const rewrites: Rewrite[] = [
  { file: "app/a.ts", search: "attach()\n", replace: "" },
  { file: "app/a.ts", search: "const on = true", replace: "const on = false" },
  { file: "app/b.ts", search: "other", replace: "x" },
]

describe("applyRewrites", () => {
  it("applies the rewrites of one file in order", () => {
    expect(applyRewrites("const on = true\nattach()\nend\n", "app/a.ts", rewrites)).toBe("const on = false\nend\n")
  })

  it("leaves other files alone", () => {
    expect(applyRewrites("untouched", "app/c.ts", rewrites)).toBe("untouched")
  })

  it("fails when a search text is missing", () => {
    expect(() => applyRewrites("const on = true\n", "app/a.ts", rewrites)).toThrow(
      /app\/a\.ts: expected 1 match of the rewrite text, found 0/,
    )
  })

  it("fails when a search text occurs twice", () => {
    expect(() => applyRewrites("const on = true\nattach()\nattach()\n", "app/a.ts", rewrites)).toThrow(/found 2/)
  })

  it("inserts replacement text literally", () => {
    const r: Rewrite[] = [{ file: "f.ts", search: "x", replace: "$&$1" }]
    expect(applyRewrites("x", "f.ts", r)).toBe("$&$1")
  })
})

describe("featureRewrites plugin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewrites-"))
  fs.mkdirSync(path.join(dir, "app"))
  fs.writeFileSync(path.join(dir, "app/a.ts"), "const on = true\nattach()\n")
  fs.writeFileSync(path.join(dir, "app/b.ts"), "other\n")

  it("transforms only the listed files", () => {
    const plugin = featureRewrites(dir, rewrites) as any
    expect(plugin.transform("const on = true\nattach()\n", path.join(dir, "app/a.ts?v=1"))).toEqual({
      code: "const on = false\n",
      map: null,
    })
    expect(plugin.transform("x", path.join(dir, "app/c.ts"))).toBeNull()
  })

  it("checks every file on disk at build start", () => {
    fs.writeFileSync(path.join(dir, "app/b.ts"), "changed upstream\n")
    const plugin = featureRewrites(dir, rewrites) as any
    expect(() => plugin.buildStart()).toThrow(/app\/b\.ts: expected 1 match/)
  })

  it("does nothing without rewrites", () => {
    const plugin = featureRewrites(dir, []) as any
    expect(() => plugin.buildStart()).not.toThrow()
    expect(plugin.transform("const on = true", path.join(dir, "app/a.ts"))).toBeNull()
  })
})
