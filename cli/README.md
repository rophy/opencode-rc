# opencode-rc

Remote control CLI for [OpenCode](https://opencode.ai). Connects your dev machine to an [opencode-rc gateway](https://github.com/rophy/opencode-rc) via a reverse WebSocket tunnel so you can access OpenCode from a browser.

## Install

```bash
npm install -g opencode-rc
```

Requires [OpenCode](https://opencode.ai) to be installed (`opencode` on PATH).

## Usage

```bash
opencode-rc
```

The CLI will:
1. Authenticate via OIDC (opens browser for PKCE flow)
2. Start OpenCode on your machine
3. Open a WebSocket tunnel to the gateway
4. Keep the tunnel alive with automatic reconnection

Press `Ctrl+C` to stop.

## Configuration

Create `~/.config/opencode/rc.json`:

```json
{
  "gatewayUrl": "https://opencode-rc.example.com",
  "oidc": {
    "issuer": "https://sso.example.com",
    "clientId": "opencode-rc-cli",
    "callbackPorts": [43212, 43213, 43214, 43215]
  }
}
```

Environment variables override the config file:

| Variable | Description |
|----------|-------------|
| `OPENCODE_RC_GATEWAY_URL` | Gateway URL |
| `OIDC_ISSUER` | OIDC provider URL |
| `OIDC_CLIENT_ID` | OIDC client ID (public client for PKCE) |
| `OIDC_CLIENT_SECRET` | Client secret (optional, for confidential clients) |
| `OIDC_CALLBACK_PORTS` | Comma-separated local ports for OIDC callback (default: 43212-43215) |
| `TLS_INSECURE_SKIP_VERIFY` | Set to `true` to skip TLS certificate verification |
