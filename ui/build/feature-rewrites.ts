import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

export interface Rewrite {
  /** Relative to vendor/opencode/packages. */
  file: string
  search: string
  replace: string
}

// Each search text must occur exactly once; the replacement is inserted literally.
export function applyRewrites(code: string, file: string, rewrites: Rewrite[]): string {
  let out = code
  for (const r of rewrites) {
    if (r.file !== file) continue
    const count = out.split(r.search).length - 1
    if (count !== 1) {
      throw new Error(
        `${file}: expected 1 match of the rewrite text, found ${count}. opencode changed: update ui/build/*-rewrites.ts.\n` +
          `First line: ${r.search.split("\n")[0]}`,
      )
    }
    out = out.replace(r.search, () => r.replace)
  }
  return out
}

// Removes disabled features from upstream opencode at build time. buildStart checks every
// rewrite against the files on disk, so an opencode bump that changes or moves the code
// fails the build instead of silently bringing a feature back.
export function featureRewrites(packagesDir: string, rewrites: Rewrite[]): Plugin {
  const files = [...new Set(rewrites.map((r) => r.file))]
  return {
    name: "feature-rewrites",
    enforce: "pre",
    buildStart() {
      for (const file of files) applyRewrites(fs.readFileSync(path.join(packagesDir, file), "utf8"), file, rewrites)
    },
    transform(code, id) {
      const file = path.relative(packagesDir, id.split("?")[0])
      if (!files.includes(file)) return null
      return { code: applyRewrites(code, file, rewrites), map: null }
    },
  }
}
