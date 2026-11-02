// Copies the built UI (dist/) into the app projects. The iOS copy's CSP allows connections only
// to the app itself: the iOS shell forwards server requests (src/native-transport.ts).
//   bun build/sync-mobile.ts ios|android
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEST = {
  ios: "ios/App/App/public",
  android: "android/app/src/main/assets/public",
} as const

export function iosCsp(html: string): string {
  return html.replace(/connect-src (?:&#39;|[^;"])*/, (match) =>
    match.includes("&#39;") ? "connect-src &#39;self&#39; data:" : "connect-src 'self' data:",
  )
}

function indexFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => path.basename(f) === "index.html")
    .map((f) => path.join(dir, f))
}

export function syncMobile(target: keyof typeof DEST, dist: string, dest: string): void {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`${dist}/index.html is missing: build the UI first`)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(dist, dest, { recursive: true })
  if (target === "ios") for (const f of indexFiles(dest)) fs.writeFileSync(f, iosCsp(fs.readFileSync(f, "utf8")))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const target = process.argv[2]
  if (target !== "ios" && target !== "android") {
    console.error("usage: bun build/sync-mobile.ts ios|android")
    process.exit(2)
  }
  const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  syncMobile(target, path.join(ui, "dist"), path.join(ui, DEST[target]))
  console.log(`synced dist/ to ${DEST[target]}`)
}
