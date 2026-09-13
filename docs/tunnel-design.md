# Reverse Tunnel Design

## Problem

The current architecture requires the gateway to dial out to CLI nodes:

```
Browser → Gateway → (HTTP to CLI endpoint) → opencode serve
```

This breaks in corporate environments where:
- CLI nodes are behind NAT/firewalls with no inbound ports
- Network policies block gateway → dev machine traffic
- The CLI must configure a routable `endpoint` address and port manually

## Solution

Reverse the connection: the CLI opens a persistent WebSocket to the gateway and holds it open. The gateway sends proxied requests through this tunnel instead of dialing out.

```
Browser → Gateway → (yamux stream over WebSocket) → CLI → localhost opencode serve
```

Only the CLI needs outbound access to the gateway — no inbound ports, no firewall rules, no endpoint or port config.

## Port and Binding

opencode serve is only accessed from localhost by the tunnel proxy. This means:

- **Bind to `127.0.0.1`** instead of `0.0.0.0` — nothing external connects
- **Use port 0** (OS-assigned ephemeral port) — no conflicts, no config needed
- **Remove `servePort` and `endpoint` config** — fully self-managed

```typescript
const server = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 0,  // OS picks an available port
});
// server.url → http://127.0.0.1:54321 (random available port)
```

## Protocol

### Tunnel Establishment

1. CLI connects: `GET /gateway/tunnel?sessionId=XXX` with `Authorization: Bearer <idToken>` and WebSocket upgrade headers
2. Gateway validates the token, extracts user identity
3. Gateway upgrades to WebSocket, registers the session with the tunnel connection
4. Both sides wrap the WebSocket in a **yamux** session (gateway = server, CLI = client)
5. CLI starts a heartbeat (yamux has built-in keepalive, but we also ping at the application level to detect dead connections faster)

### Request Proxying

When the gateway receives `GET /s/{sessionID}/api/session`:

1. Gateway looks up the session's tunnel connection
2. Opens a new yamux stream
3. Writes the HTTP request (method, path, headers, body) onto the stream
4. CLI reads the request from the stream, proxies to `localhost:{actual port}`
5. CLI writes the HTTP response back onto the stream
6. Gateway reads the response and sends it to the browser

Each yamux stream is an independent bidirectional byte stream — multiple concurrent requests (API calls, SSE, WebSocket for PTY) run in parallel over the single tunnel WebSocket.

### Connection Lifecycle

- **Reconnect**: if the tunnel drops, the CLI reconnects with exponential backoff
- **Heartbeat**: yamux keepalive + application-level ping detect dead connections; gateway marks session offline after timeout
- **Shutdown**: CLI closes the yamux session gracefully on SIGINT/SIGTERM, gateway deregisters the session

## Components

### Gateway Side

**Dependencies**: `github.com/hashicorp/yamux`, `github.com/gorilla/websocket`

**New files**:
- `tunnel.go` — tunnel handler, yamux server session management

**Modified files**:
- `registry.go` — `Session` gains a `Tunnel *yamux.Session` field (nil = legacy direct mode)
- `routes.go` — add `/gateway/tunnel` route with auth middleware
- `proxy.go` — `ProxyHandler` checks `session.Tunnel` first; if present, opens a yamux stream and writes/reads HTTP over it instead of using `httputil.ReverseProxy`

**Tunnel handler flow**:
```go
func (a *Auth) TunnelHandler(registry *Registry) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // 1. Validate Bearer token (same as RegistrationAuthMiddleware)
        // 2. Extract sessionID from query param
        // 3. Upgrade to WebSocket
        // 4. Wrap WebSocket conn in yamux.Server
        // 5. Register session with tunnel reference
        // 6. Block until tunnel closes, then deregister
    }
}
```

**Proxy with tunnel**:
```go
// In ProxyHandler, after session lookup:
if session.Tunnel != nil {
    stream, err := session.Tunnel.Open()
    // Write HTTP request to stream
    // Read HTTP response from stream
    // Copy response to browser
    return
}
// Fall through to existing httputil.ReverseProxy for legacy direct mode
```

### CLI Side

**Dependencies**: `yamux` npm package (or raw multiplexing over WebSocket frames)

**New files**:
- `tunnel.ts` — connects WebSocket to gateway, wraps in yamux client, accepts streams, proxies each to localhost

**Modified files**:
- `index.ts` — use tunnel instead of register+heartbeat when tunnel mode is active
- `server.ts` — bind to `127.0.0.1:0` (OS-assigned port)
- `config.ts` — remove `servePort` and `endpoint` fields
- `register.ts` — remove (replaced by tunnel)

**Tunnel client flow**:
```typescript
export async function startTunnel(config, idToken, sessionID, localUrl) {
    // 1. Connect WebSocket to gateway/tunnel?sessionId=XXX
    // 2. Wrap in yamux client session
    // 3. Accept incoming streams in a loop
    // 4. For each stream: read HTTP request, proxy to localUrl, write response back
    // 5. Handle reconnect on disconnect
}
```

## Config

Tunnel replaces all network config. The only required fields are gateway URL and OIDC:

```json
{
  "gatewayUrl": "https://gateway.example.com",
  "oidc": { "issuer": "...", "clientId": "..." }
}
```

No port, endpoint, or mode config needed.

## Migration

- Tunnel replaces the direct proxy model entirely
- Remove `servePort`, `endpoint`, `OPENCODE_RC_SERVE_PORT`, `OPENCODE_RC_ENDPOINT` from CLI
- Remove registration API (`/gateway/register`, heartbeat, deregister) from gateway
- Remove `register.ts` from CLI
- No changes to `opencode serve` — it still listens on localhost
- Existing rc.json files with `servePort`/`endpoint` fields are silently ignored

## yamux JS Options

For the CLI (Node.js), options for yamux:
1. **`@pires/yamux`** — JS port of hashicorp/yamux, but may be unmaintained
2. **Custom framing** — simpler: use WebSocket message framing with a stream ID header; each message is `[streamID, data]`. Less battle-tested but no dependency.
3. **`node:http2`** — HTTP/2's built-in multiplexing could replace yamux entirely. CLI opens an HTTP/2 connection to the gateway tunnel endpoint; gateway opens HTTP/2 streams for each proxied request. No extra library needed on either side.

**Recommendation**: Start with option 3 (HTTP/2) if feasible — it's stdlib on both Go and Node, purpose-built for multiplexed streams, and well-maintained. Fall back to custom framing over WebSocket if HTTP/2 tunneling proves awkward with the existing gateway setup.

## Open Questions

1. **HTTP/2 vs yamux over WebSocket**: HTTP/2 is cleaner but may complicate the gateway if it's already terminating TLS/HTTP/1.1. yamux over WebSocket works at any layer.
2. **SSE handling**: SSE streams are long-lived. With yamux, each SSE response holds a stream open — yamux handles this natively. Need to verify the CLI-side proxy correctly streams the response without buffering.
3. **WebSocket-over-tunnel**: PTY uses WebSocket. Tunneling a WebSocket inside a yamux stream inside a WebSocket is nested but functional — the inner WebSocket is just HTTP upgrade + framed bytes from yamux's perspective.
4. **Max concurrent streams**: yamux defaults to 128 concurrent streams. Should be plenty, but configurable.
