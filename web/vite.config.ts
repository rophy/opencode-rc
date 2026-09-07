import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "path"
import fs from "fs"

// The sibling opencode repo provides all @opencode-ai/* packages and their
// npm dependencies. In CI, clone it as a build step.
const opencodeRoot = process.env.OPENCODE_ROOT || path.resolve(__dirname, "../vendor/opencode")
const opencodePackages = path.join(opencodeRoot, "packages")
const appNodeModules = path.join(opencodePackages, "app/node_modules")

// Load all @opencode-ai/* package metadata for exports resolution
interface PkgMeta {
  name: string
  dir: string
  exports: Record<string, string>
}

function loadOpenCodePackages(): PkgMeta[] {
  const packages: PkgMeta[] = []
  for (const dir of fs.readdirSync(opencodePackages)) {
    const pkgJsonPath = path.join(opencodePackages, dir, "package.json")
    if (!fs.existsSync(pkgJsonPath)) continue
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"))
    if (pkgJson.name?.startsWith("@opencode-ai/")) {
      packages.push({
        name: pkgJson.name,
        dir: path.join(opencodePackages, dir),
        exports: pkgJson.exports || {},
      })
    }
  }
  return packages
}

const ocPackages = loadOpenCodePackages()

// Resolve @opencode-ai/pkg/subpath using the package's exports map
function resolveExport(source: string): string | null {
  for (const pkg of ocPackages) {
    if (source === pkg.name) {
      // Bare import: resolve "." export
      const entry = pkg.exports["."]
      if (entry) return path.join(pkg.dir, typeof entry === "string" ? entry : "")
      return path.join(pkg.dir, "src/index.ts")
    }
    if (!source.startsWith(pkg.name + "/")) continue

    const subpath = "./" + source.slice(pkg.name.length + 1)

    // Try exact match first
    if (pkg.exports[subpath]) {
      return path.join(pkg.dir, pkg.exports[subpath])
    }

    // Try wildcard patterns, sorted by specificity (longest prefix first)
    const wildcardEntries = Object.entries(pkg.exports)
      .filter(([p, t]) => typeof t === "string" && p.includes("*"))
      .sort(([a], [b]) => b.split("*")[0].length - a.split("*")[0].length)
    for (const [pattern, target] of wildcardEntries) {
      const [prefix, suffix] = pattern.split("*")
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix || "")) {
        const wildcard = subpath.slice(prefix.length, suffix ? -suffix.length : undefined)
        const resolved = path.join(pkg.dir, (target as string).replace("*", wildcard))
        if (fs.existsSync(resolved)) return resolved
      }
    }

    // Fallback: direct file path
    const directPath = path.join(pkg.dir, subpath.slice(2))
    if (fs.existsSync(directPath)) return directPath
  }
  return null
}

function opencodeResolver(): Plugin {
  return {
    name: "opencode-resolver",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Handle @opencode-ai/* imports from anywhere
      if (source.startsWith("@opencode-ai/")) {
        const resolved = resolveExport(source)
        if (resolved) return resolved
      }

      if (!importer) return null
      // Only intercept bare imports (not relative, not absolute, not virtual)
      if (source.startsWith(".") || source.startsWith("/") || source.startsWith("\0")) return null
      // Only when the importer is inside the opencode repo
      if (!importer.startsWith(opencodeRoot + "/")) return null

      // Resolve npm deps from the opencode repo's node_modules
      const possiblePaths = [
        path.join(appNodeModules, source),
        path.join(opencodeRoot, "node_modules", source),
      ]

      for (const candidate of possiblePaths) {
        try {
          const resolved = await this.resolve(source, path.join(candidate, "_virtual_importer.js"), {
            ...options,
            skipSelf: true,
          })
          if (resolved) return resolved
        } catch {
          // fall through
        }
      }

      return null
    },
  }
}

export default defineConfig({
  base: "./",
  plugins: [opencodeResolver(), solid(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(opencodePackages, "app/src"),
    },
    conditions: ["import", "module", "browser", "default"],
    dedupe: ["solid-js", "@solidjs/router"],
  },
  server: {
    host: "0.0.0.0",
    port: 3001,
    fs: {
      allow: [opencodeRoot, __dirname],
    },
    proxy: {
      "/api": "http://localhost:12029",
      "/auth": "http://localhost:12029",
      "/gateway": "http://localhost:12029",
      "/s": "http://localhost:12029",
      "/healthz": "http://localhost:12029",
    },
  },
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
})
