// Content-Security-Policy for the UI: the meta tag in every build (what the mobile apps get)
// and the header the web image's nginx sends. With a preset server, connect-src allows only
// that origin (http(s) and its WebSocket form), so an injected script cannot send a token
// elsewhere; without one the user picks the server at runtime, so any origin is allowed.
export function contentSecurityPolicy(serverUrl?: string, opts: { frameAncestors?: boolean } = {}): string {
  let connect = "'self' data: http: https: ws: wss:"
  if (serverUrl) {
    const origin = new URL(serverUrl).origin
    connect = `'self' data: ${origin} ${origin.replace(/^http/, "ws")}`
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "media-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    // Ignored in a meta tag; only the HTTP header can set it.
    ...(opts.frameAncestors ? ["frame-ancestors 'none'"] : []),
  ].join("; ")
}
