// @vitest-environment node
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createTwoFilesPatch } from "diff"
import { FEATURES, FEATURES_V2 } from "../../config/schema"
import { applyPatches, featurePatches, readPatches, vendorPatches } from "./vendor-patches"

const A = "const on = true\nattach()\nend\n"
const B = "other\n"
const gitPatch = (file: string, before: string, after: string) => createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after)

// A fake opencode root with two files and a patch directory for them.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-patches-"))
  fs.mkdirSync(path.join(root, "app"))
  fs.writeFileSync(path.join(root, "app/a.ts"), A)
  fs.writeFileSync(path.join(root, "app/b.ts"), B)
  const dir = path.join(root, "patches")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "1-a.patch"), gitPatch("app/a.ts", A, "const on = false\nend\n"))
  fs.writeFileSync(path.join(dir, "2-b.patch"), gitPatch("app/b.ts", B, "x\n"))
  return { root, dir }
}

describe("readPatches", () => {
  it("reads every file patch in name order", () => {
    const { dir } = fixture()
    expect(readPatches(dir).map((p) => [p.file, path.basename(p.source)])).toEqual([
      ["app/a.ts", "1-a.patch"],
      ["app/b.ts", "2-b.patch"],
    ])
  })

  it("rejects renames and new files", () => {
    const { dir } = fixture()
    fs.writeFileSync(path.join(dir, "3-new.patch"), createTwoFilesPatch("/dev/null", "b/app/c.ts", "", "x\n"))
    expect(() => readPatches(dir)).toThrow(/3-new\.patch: only edits of existing files are supported/)
  })
})

describe("applyPatches", () => {
  const { dir } = fixture()
  const patches = readPatches(dir)

  it("applies the patches of one file", () => {
    expect(applyPatches(A, "app/a.ts", patches)).toBe("const on = false\nend\n")
  })

  it("leaves other files alone", () => {
    expect(applyPatches("untouched", "app/c.ts", patches)).toBe("untouched")
  })

  it("fails without fuzz when the context changed", () => {
    expect(() => applyPatches("const on = true\nattach()\nchanged\n", "app/a.ts", patches)).toThrow(
      /1-a\.patch does not apply to app\/a\.ts: opencode changed/,
    )
  })
})

describe("vendorPatches plugin", () => {
  it("transforms only the patched files", () => {
    const { root, dir } = fixture()
    const plugin = vendorPatches(root, readPatches(dir)) as any
    expect(plugin.transform(A, path.join(root, "app/a.ts?v=1"))).toEqual({ code: "const on = false\nend\n", map: null })
    expect(plugin.transform("x", path.join(root, "app/c.ts"))).toBeNull()
  })

  it("checks every patch against the files on disk at build start", () => {
    const { root, dir } = fixture()
    fs.writeFileSync(path.join(root, "app/b.ts"), "changed upstream\n")
    const plugin = vendorPatches(root, readPatches(dir)) as any
    expect(() => plugin.buildStart()).toThrow(/2-b\.patch does not apply to app\/b\.ts/)
  })

  it("fails the bundle when a patched file was never transformed", () => {
    const { root, dir } = fixture()
    const plugin = vendorPatches(root, readPatches(dir)) as any
    plugin.buildStart()
    plugin.transform(A, path.join(root, "app/a.ts"))
    expect(() => plugin.generateBundle()).toThrow(/^app\/b\.ts was not transformed; its patch did not apply/)
  })

  it("forgets transformed files at the next build start", () => {
    const { root, dir } = fixture()
    const plugin = vendorPatches(root, readPatches(dir)) as any
    plugin.buildStart()
    plugin.transform(A, path.join(root, "app/a.ts"))
    plugin.transform(B, path.join(root, "app/b.ts"))
    expect(() => plugin.generateBundle()).not.toThrow()
    plugin.buildStart()
    expect(() => plugin.generateBundle()).toThrow(/app\/a\.ts, app\/b\.ts was not transformed/)
  })

  it("does nothing without patches", () => {
    const { root } = fixture()
    const plugin = vendorPatches(root, []) as any
    expect(() => plugin.buildStart()).not.toThrow()
    expect(plugin.transform(A, path.join(root, "app/a.ts"))).toBeNull()
    expect(() => plugin.generateBundle()).not.toThrow()
  })
})

describe("featurePatches", () => {
  // vendor/patches/<version> with a directory per feature
  function patchesRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "feature-patches-"))
    for (const [name, file] of [["uploads", "app/a.ts"], ["terminal", "app/b.ts"]]) {
      fs.mkdirSync(path.join(root, name))
      fs.writeFileSync(path.join(root, name, "x.patch"), gitPatch(file, "old\n", "new\n"))
    }
    return root
  }

  it("returns the patches of the disabled features only", () => {
    const root = patchesRoot()
    expect(featurePatches(root, ["uploads", "terminal"], ["terminal"]).map((p) => p.file)).toEqual(["app/b.ts"])
    expect(featurePatches(root, ["uploads", "terminal"], [])).toEqual([])
  })

  it("allows a disabled feature without a directory", () => {
    const root = patchesRoot()
    expect(featurePatches(root, ["uploads", "terminal", "other"], ["other"])).toEqual([])
  })

  it("rejects a directory that names no feature", () => {
    const root = patchesRoot()
    expect(() => featurePatches(root, ["uploads"], [])).toThrow(/terminal is not a feature in config\/schema\.ts/)
  })

  it("matches the features in the real vendor/patches/v1", () => {
    const real = fileURLToPath(new URL("../../vendor/patches/v1", import.meta.url))
    expect(fs.readdirSync(real).sort()).toEqual(["downloads", "export", "share", "shell", "terminal", "uploads"])
    expect(() => featurePatches(real, FEATURES, [])).not.toThrow()
  })

  it("matches the features in the real vendor/patches/v2", () => {
    const real = fileURLToPath(new URL("../../vendor/patches/v2", import.meta.url))
    expect(fs.readdirSync(real).sort()).toEqual(["downloads", "export", "shell", "terminal", "uploads"])
    expect(() => featurePatches(real, FEATURES_V2, [])).not.toThrow()
  })
})
