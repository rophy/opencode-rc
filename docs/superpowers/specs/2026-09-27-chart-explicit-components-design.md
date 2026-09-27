# Chart: Explicit Components Instead of `profile`

Date: 2026-09-27
Status: Approved design

## Problem

The chart's `profile` value (`local` | `production`) bundles several unrelated decisions:
whether the OIDC mock runs, whether the chart renders its own Secret, whether login
cookies are `Secure`, and whether `oidc.issuer` is required. Real setups mix these (for
example a dev cluster behind an http ingress on a non-default port, using the mock), and
`profile` cannot express them.

The OIDC mock's configuration also depends on the wrong side. The mock reads its client
ids, client secret and redirect URI from `oidc.*` and `secrets.*`, and whether it is
exposed depended on `oidc.issuer`. The API's OIDC settings are the consumer and the mock
is the provider, so the dependency should point the other way.

## Goals

- Every component is switched on or off explicitly, like `ui.enabled` and `redis.enabled`.
- `oidcMock.*` is self-contained: the mock's templates never read `oidc.*`.
- `oidc.*` values left empty fall back to the mock when it is enabled.
- `helm install` with no values keeps working out of the box, as `profile: local` did.

## Non-goals

- A `values.schema.json` (separate follow-up; it will reject stale keys such as `profile`).
- Migration handling for `profile`. The chart is not GA; the key is simply ignored.
- A chart version bump.

## Decisions

| Topic | Decision |
|---|---|
| `profile` | Removed, no mapping and no failure when still set |
| Mock on/off | New `oidcMock.enabled`, default `true` |
| Direction | `oidc.*` defaults from `oidcMock.*`; never the reverse |
| Chart Secret | Rendered whenever `existingSecret` is empty; nothing requires `existingSecret` |
| `COOKIE_SECURE` | `api.cookieSecure` if set, else true iff the API public URL is `https://` |
| Missing IdP | Render fails when `oidc.issuer` is empty and the mock is disabled |

## Values

```yaml
oidcMock:
  enabled: true
  issuer: ""            # else {expose.scheme}://{release}-oidc.{expose.host} when exposed,
                        # else the in-cluster service URL (unchanged)
  clients:
    web:
      id: opencode-rc
      secret: opencode-rc-secret
      redirectUris: []  # [] -> <api public URL>/auth/callback
    cli:
      id: opencode-rc-cli
      redirectUris: ["http://127.0.0.1:0/callback"]
  users:
    - { sub: user1, email: alice@example.com, name: Alice }
    - { sub: user2, email: bob@example.com, name: Bob }

oidc:
  issuer: ""            # required unless oidcMock.enabled
  clientId: ""          # "" -> oidcMock.clients.web.id if enabled, else "opencode-rc"
  cliClientId: ""       # "" -> oidcMock.clients.cli.id if enabled, else "opencode-rc-cli"
  # redirectUri, issuerOverride, authorizationEndpoint, tokenEndpoint, jwksUri: unchanged

api:
  cookieSecure: null    # null -> derived from the API public URL

secrets:
  oidcClientSecret: ""  # "" -> oidcMock.clients.web.secret if enabled

existingSecret: ""
```

`profile` is deleted from `values.yaml`.

## Rules

### OIDC mock

- Deployment, Service and ConfigMap render when `oidcMock.enabled`.
- Exposed on `{release}-oidc.{expose.host}` whenever it is enabled and `expose.type` is not
  `none`, regardless of `oidc.*`.
- The ConfigMap is built from `oidcMock.issuer` (or its derived default), `oidcMock.clients`
  and `oidcMock.users`. The web client's default redirect URI is the API public URL plus
  `/auth/callback`; this comes from `api.publicUrl` / `expose.*`, not from `oidc.redirectUri`.

### OIDC settings of the API and gateway

Each value resolves to the explicit `oidc.*` value if set, else the mock-derived value when
`oidcMock.enabled`, else the built-in default (client ids) or a render failure (issuer).

| Env | Explicit | From the mock | Otherwise |
|---|---|---|---|
| `OIDC_ISSUER` (discovery) | `oidc.issuer` | mock issuer; in-cluster service URL when the mock is exposed | fail |
| `OIDC_CLIENT_ID` | `oidc.clientId` | `oidcMock.clients.web.id` | `opencode-rc` |
| `OIDC_CLI_CLIENT_ID` | `oidc.cliClientId` | `oidcMock.clients.cli.id` | `opencode-rc-cli` |
| `oidc-client-secret` (Secret) | `secrets.oidcClientSecret` | `oidcMock.clients.web.secret` | `""` |

**Split discovery.** When `oidc.issuer` is empty and the mock is exposed, the API and gateway
fetch discovery, tokens and keys from the in-cluster service and send browsers to the mock's
issuer. This now applies whether the issuer is derived or set with `oidcMock.issuer` (for
example an issuer URL with a port that pods cannot reach). Explicit `oidc.issuerOverride`,
`oidc.authorizationEndpoint`, `oidc.tokenEndpoint` and `oidc.jwksUri` still win.

When `oidc.issuer` is set, the mock may still run and be exposed; it is simply not used.

### Secret

- `existingSecret` set: the chart renders no Secret and all components read that one.
- `existingSecret` empty: the chart renders a Secret from `secrets.*` (dev defaults for the
  token secret, as today), with `oidc-client-secret` resolved as above.
- With the mock and `existingSecret` together, the Secret's `oidc-client-secret` must equal
  `oidcMock.clients.web.secret`; the README says so.

### Cookies

`COOKIE_SECURE` covers the short-lived login cookies (`orc_state`, `orc_return`,
`orc_challenge`). It is `api.cookieSecure` when set, else `"true"` when the API public URL
starts with `https://`, else `"false"`.

### NOTES

The `Profile:` line is removed. The CLI hint uses the resolved issuer and CLI client id.

## Testing

helm unittest cases:

- Mock ConfigMap uses `oidcMock.clients` / `oidcMock.users`, and ignores `oidc.clientId`,
  `oidc.cliClientId`, `oidc.redirectUri` and `secrets.oidcClientSecret`.
- Mock rendered/not rendered by `oidcMock.enabled`; exposed with and without `oidc.issuer`.
- API and gateway env: client ids and issuer from the mock; explicit `oidc.*` wins; built-in
  client ids with the mock disabled.
- Render fails with the mock disabled and no `oidc.issuer`.
- Split discovery with a derived issuer and with `oidcMock.issuer`.
- Secret: rendered without `existingSecret`, absent with it; `oidc-client-secret` resolution.
- `COOKIE_SECURE`: derived from http and https public URLs; `api.cookieSecure` override.

`profile_validation_test.yaml` is replaced by these cases. e2e keeps the default values,
which give the same behaviour as before, and must pass unchanged.

## Docs

README: remove `profile` from the values table, add `oidcMock.enabled`, `oidcMock.clients`,
`oidcMock.users` and `api.cookieSecure`, and replace the "Local Profile" section with a short
"Bundled OIDC mock" section: configured by `oidcMock.*`; empty `oidc.*` values default to it;
disable it and set `oidc.issuer` and `existingSecret` for a real IdP.
