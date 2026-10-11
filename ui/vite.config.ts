import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "path"
import fs from "fs"
import { FEATURES, FEATURES_V2, parseConfig, parseConfigText, type RcConfig } from "../config/schema.ts"
import { contentSecurityPolicy } from "./csp.ts"
import { featurePatches, vendorPatches } from "./build/vendor-patches.ts"

// Which opencode the build wraps: unset or "1" builds the 1.x UI at /, "2" the 2.x UI at /v2/.
const major = process.env.OPENCODE_MAJOR ?? "1"
if (major !== "1" && major !== "2") throw new Error(`OPENCODE_MAJOR must be 1 or 2, got ${major}`)
const v2 = major === "2"
// The submodule provides all of its packages and their npm dependencies.
const opencodeRoot = v2
  ? process.env.OPENCODE_V2_ROOT || path.resolve(import.meta.dirname, "../vendor/opencode-v2")
  : process.env.OPENCODE_ROOT || path.resolve(import.meta.dirname, "../vendor/opencode-v1")
const scope = v2 ? "@opencode/" : "@opencode-ai/"
const opencodePackages = path.join(opencodeRoot, "packages")
const appNodeModules = path.join(opencodePackages, "app/node_modules")

// Load all package metadata for exports resolution
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
    if (pkgJson.name?.startsWith(scope)) {
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

// The deployment config (config.json) named by OPENCODE_RC_CONFIG, relative to ui/ or
// absolute. Unset: no preset server, every feature enabled. An invalid file fails the build.
function readBuildConfig(): RcConfig {
  const file = process.env.OPENCODE_RC_CONFIG
  if (!file) return parseConfig({})
  return parseConfigText(fs.readFileSync(path.resolve(import.meta.dirname, file), "utf8"), file)
}

const rcConfig = readBuildConfig()

// Resolve <scope>pkg/subpath using the package's exports map
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
      // Handle <scope>* imports from anywhere
      if (source.startsWith(scope)) {
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

// opencode's app CSS loads its fonts from "/assets/…", which opencode's own build serves from
// packages/app/public. We build with our own public dir, so point those URLs at the files
// relatively; Vite then bundles them with content hashes like every other asset.
function opencodeAppFonts(): Plugin {
  const appCss = path.join(opencodePackages, "app/src/index.css")
  return {
    name: "opencode-app-fonts",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?")[0] !== appCss) return null
      return code.replace(/url\((["']?)\/assets\//g, "url($1../public/assets/")
    },
  }
}

// Production builds carry a CSP meta tag, which is what the mobile apps get (the web image's
// nginx sends the same policy as a header, plus frame-ancestors).
function cspMeta(): Plugin {
  const content = contentSecurityPolicy(rcConfig.serverUrl)
  return {
    name: "csp-meta",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content }, injectTo: "head-prepend" },
    ],
  }
}

export default defineConfig({
  base: v2 ? "/v2/" : "/",
  define: {
    __RC_CONFIG__: JSON.stringify(rcConfig),
  },
  plugins: [
    // vendor/patches/<v1|v2>/<feature>: our changes to opencode, applied when the feature is disabled.
    vendorPatches(
      opencodeRoot,
      v2
        ? featurePatches(
            path.resolve(import.meta.dirname, "../vendor/patches/v2"),
            FEATURES_V2,
            FEATURES_V2.filter((name) => !rcConfig.opencodeV2.features[name].enabled),
          )
        : featurePatches(
            path.resolve(import.meta.dirname, "../vendor/patches/v1"),
            FEATURES,
            FEATURES.filter((name) => !rcConfig.features[name].enabled),
          ),
    ),
    opencodeResolver(),
    opencodeAppFonts(),
    solid(),
    tailwindcss(),
    cspMeta(),
  ],
  resolve: {
    alias: {
      "@": path.join(opencodePackages, "app/src"),
      "#session-view": path.join(import.meta.dirname, v2 ? "src/session-view-v2.tsx" : "src/session-view-v1.tsx"),
      // Mirrors packages/app/vite.js upstream.
      ...(v2
        ? { "@betteroffice/fonts-cjk": path.join(opencodePackages, "gui-extensions/src/microsoft-office/fonts-cjk.ts") }
        : {}),
    },
    conditions: ["import", "module", "browser", "default"],
    dedupe: ["solid-js", "@solidjs/router"],
  },
  server: {
    host: "0.0.0.0",
    port: 3001,
    fs: {
      allow: [opencodeRoot, import.meta.dirname],
    },
    proxy: {
      "/api": "http://localhost:12029",
      "/auth": "http://localhost:12029",
      "/gateway": "http://localhost:12029",
      "/proxy": { target: "http://localhost:12029", ws: true },
      "/healthz": "http://localhost:12029",
    },
  },
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
    // The 2.x build lands in dist/v2 and empties only that; `bun run build` runs 1.x first.
    outDir: v2 ? "dist/v2" : "dist",
    emptyOutDir: true,
  },
})
