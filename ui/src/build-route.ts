// The mobile apps serve the bundled ui/dist from a local server that answers any path without a
// file extension with the ROOT index.html, so /v2/s/<id>/ loads the 1.x build. The 1.x build
// bounces to the real file /v2/index.html carrying the original path, and the 2.x build restores
// it before rendering. On the web nginx serves /v2/* itself, so neither step triggers there.

const V2 = "/v2/"
const INDEX = "/v2/index.html"

export function bounceTarget(base: string, loc: { pathname: string; search: string; hash: string }): string | null {
  if (base !== "" || !loc.pathname.startsWith(V2)) return null
  return `${INDEX}?rc_path=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`
}

export function restoredPath(base: string, loc: { pathname: string; search: string }): string | null {
  if (base !== "/v2" || loc.pathname !== INDEX) return null
  const path = new URLSearchParams(loc.search).get("rc_path")
  return path && path.startsWith(V2) ? path : null
}
