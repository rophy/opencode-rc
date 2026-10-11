import fs from "node:fs"
import path from "node:path"
import { applyPatch, parsePatch, type StructuredPatch } from "diff"
import type { Plugin } from "vite"

export interface FilePatch {
  /** Relative to the opencode root (vendor/opencode-v1). */
  file: string
  patch: StructuredPatch
  /** The .patch file it came from, for error messages. */
  source: string
}

// Reads the .patch files in dir (git diff output, paths relative to the opencode root, e.g. vendor/opencode-v1), in
// name order. Only edits of existing files are supported.
export function readPatches(dir: string): FilePatch[] {
  const out: FilePatch[] = []
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".patch")).sort()) {
    const source = path.join(dir, name)
    for (const patch of parsePatch(fs.readFileSync(source, "utf8"))) {
      const oldFile = patch.oldFileName?.replace(/^a\//, "")
      const file = patch.newFileName?.replace(/^b\//, "")
      if (!file || file !== oldFile) {
        throw new Error(`${source}: only edits of existing files are supported (${patch.oldFileName} -> ${patch.newFileName})`)
      }
      out.push({ file, patch, source })
    }
  }
  return out
}

// The patches of the disabled features, from vendor/patches/<version>/<feature>/. A directory named
// after several features joined by "+" (config+shell) holds changes they share, applied once when
// any of them is disabled, so their patches apply in every combination. A directory that names no
// feature is an error, so a typo cannot silently leave a feature in the app. A feature without a
// directory has nothing to patch (the API enforces it alone). Directories apply in the order of
// their first disabled feature, a feature's own directory before shared ones, then by name.
export function featurePatches(patchesRoot: string, features: readonly string[], disabled: readonly string[]): FilePatch[] {
  const dirs = fs.existsSync(patchesRoot)
    ? fs.readdirSync(patchesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []
  const unknown = dirs.filter((dir) => dir.split("+").some((name) => !features.includes(name)))
  if (unknown.length > 0) {
    throw new Error(`${patchesRoot}: ${unknown.join(", ")} is not a feature in config/schema.ts`)
  }
  const rank = (dir: string) => Math.min(...dir.split("+").map((name) => disabled.indexOf(name)).filter((i) => i >= 0))
  return dirs
    .filter((dir) => Number.isFinite(rank(dir)))
    .sort((a, b) => rank(a) - rank(b) || Number(a.includes("+")) - Number(b.includes("+")) || a.localeCompare(b))
    .flatMap((dir) => readPatches(path.join(patchesRoot, dir)))
}

// Applies the patches for one file, in order, with no fuzz: context must match exactly.
export function applyPatches(code: string, file: string, patches: FilePatch[]): string {
  let out = code
  for (const p of patches) {
    if (p.file !== file) continue
    const next = applyPatch(out, p.patch, { fuzzFactor: 0 })
    if (next === false) {
      throw new Error(`${p.source} does not apply to ${file}: opencode changed, rebase the patch (see AGENTS.md)`)
    }
    out = next
  }
  return out
}

// Applies vendor/patches/<version> to upstream opencode at build time, in memory, so the submodule
// stays untouched. buildStart checks every patch against the files on disk, so an opencode
// bump that changes the code fails the build instead of silently bringing a feature back.
// generateBundle (build only) checks that every patched file actually went through
// transform, so a module resolved under another path (a symlink) cannot skip its patch.
export function vendorPatches(opencodeRoot: string, patches: FilePatch[]): Plugin {
  const files = [...new Set(patches.map((p) => p.file))]
  const transformed = new Set<string>()
  return {
    name: "vendor-patches",
    enforce: "pre",
    buildStart() {
      transformed.clear()
      for (const file of files) applyPatches(fs.readFileSync(path.join(opencodeRoot, file), "utf8"), file, patches)
    },
    transform(code, id) {
      const file = path.relative(opencodeRoot, id.split("?")[0])
      if (!files.includes(file)) return null
      const out = applyPatches(code, file, patches)
      transformed.add(file)
      return { code: out, map: null }
    },
    generateBundle() {
      const missed = files.filter((file) => !transformed.has(file))
      if (missed.length > 0) {
        throw new Error(`${missed.join(", ")} was not transformed; its patch did not apply (check OPENCODE_ROOT / symlinks)`)
      }
    },
  }
}
