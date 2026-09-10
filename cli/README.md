# opencode-rc

Remote control CLI for [OpenCode](https://opencode.ai). Connects your dev machine to an [opencode-rc gateway](https://github.com/rophy/opencode-rc) so you can access OpenCode from a browser.

The gateway is a centralized server that authenticates users via OIDC and routes browser sessions to the correct dev machine. This CLI registers your local OpenCode instance with the gateway.

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
1. Authenticate via OIDC (opens browser)
2. Start OpenCode on your machine
3. Register with the gateway
4. Keep the session alive with heartbeats

Press `Ctrl+C` to stop and deregister.

## Configuration

Create `~/.config/opencode/rc.json`:

```json
{
  "gatewayUrl": "https://opencode-rc.example.com",
  "oidc": {
    "issuer": "https://sso.example.com",
    "clientId": "opencode-rc-cli",
    "clientSecret": "optional-secret",
    "callbackPorts": [43212, 43213, 43214, 43215]
  }
}
```

Environment variables override the config file:

| Variable | Description |
|----------|-------------|
| `OPENCODE_RC_GATEWAY_URL` | Gateway URL |
| `OIDC_ISSUER` | OIDC provider URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | Client secret (optional, for confidential clients) |
| `OIDC_CALLBACK_PORTS` | Comma-separated local ports for OIDC callback (default: 43212-43215) |
