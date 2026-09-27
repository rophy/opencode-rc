# Chart Explicit Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chart's `profile` value with explicit per-component switches, make `oidcMock.*` self-contained, and let empty `oidc.*` values default to the mock.

**Architecture:** All defaulting lives in named templates in `charts/opencode-rc/templates/_helpers.tpl`, like the existing `apiPublicUrl` / `oidcIssuer` helpers. Templates call helpers instead of reading `oidc.*` / `profile` directly. The mock's templates read only `oidcMock.*`, `expose.*` and the API public URL.

**Tech Stack:** Helm 3 templates, helm-unittest (`helm unittest charts/opencode-rc`), Skaffold + kind e2e.

**Spec:** `docs/superpowers/specs/2026-09-27-chart-explicit-components-design.md`

## Global Constraints

- `profile` is removed; no mapping, no failure when still set.
- Direction: `oidc.*` defaults from `oidcMock.*`; mock templates never read `oidc.*` or `secrets.*`.
- `oidcMock.enabled` defaults to `true`; `helm install` with no values keeps working.
- Render fails with exactly `oidc.issuer is required unless oidcMock.enabled` when the mock is disabled and `oidc.issuer` is empty.
- The chart Secret renders whenever `existingSecret` is empty.
- `COOKIE_SECURE`: `api.cookieSecure` when it is a bool, else `"true"` iff the API public URL starts with `https://`.
- No chart version bump. No `values.schema.json`.
- No private hostnames in committed files.
- Commit messages: `<type>: <short description>`, no attribution lines.

## Starting state

The working tree has uncommitted edits (README, `_helpers.tpl`, ingress/oidc_mock/virtualservice tests) from an earlier approach. This plan supersedes them. Task 1 step 1 discards them.

## File map

| File | Change |
|---|---|
| `charts/opencode-rc/values.yaml` | drop `profile`; add `oidcMock.enabled/clients/users`, `api.cookieSecure`; `oidc.clientId`, `oidc.cliClientId`, `secrets.oidcClientSecret` default `""` |
| `charts/opencode-rc/templates/_helpers.tpl` | mock/oidc/secret/cookie helpers; drop `validateProduction` |
| `charts/opencode-rc/templates/oidc-mock-{deployment,service,configmap}.yaml` | gate on `oidcMock.enabled`; configmap from `oidcMock.*` |
| `charts/opencode-rc/templates/{api,gateway}-deployment.yaml` | use helpers for client ids and cookie flag; drop `validateProduction` include |
| `charts/opencode-rc/templates/secret.yaml` | gate on `existingSecret`; client secret helper |
| `charts/opencode-rc/templates/NOTES.txt` | drop `Profile:`; CLI client id helper |
| `charts/opencode-rc/tests/*.yaml` | see tasks |
| `README.md` | values table, install examples, "Bundled OIDC mock" section |

---

### Task 1: Self-contained oidc-mock with `oidcMock.enabled`

**Files:**
- Modify: `charts/opencode-rc/values.yaml` (oidcMock block, expose comment)
- Modify: `charts/opencode-rc/templates/_helpers.tpl` (`oidcMockExposed`)
- Modify: `charts/opencode-rc/templates/oidc-mock-deployment.yaml:1`, `oidc-mock-service.yaml:1`, `oidc-mock-configmap.yaml`
- Test: `charts/opencode-rc/tests/oidc_mock_test.yaml`, `ingress_test.yaml`, `virtualservice_test.yaml`

**Interfaces:**
- Produces: values `oidcMock.enabled` (bool), `oidcMock.clients.web.{id,secret,redirectUris}`, `oidcMock.clients.cli.{id,redirectUris}`, `oidcMock.users` (list of maps); helper `opencode-rc.oidcMockExposed` returns `"true"` iff `oidcMock.enabled` and expose type is not `none`.

- [ ] **Step 1: Discard the superseded working-tree edits**

```bash
git checkout -- README.md charts/opencode-rc/templates/_helpers.tpl charts/opencode-rc/tests/ingress_test.yaml charts/opencode-rc/tests/oidc_mock_test.yaml charts/opencode-rc/tests/virtualservice_test.yaml
git status --short   # only e2e/test-results/ may remain
```

- [ ] **Step 2: Write the failing tests**

In `tests/oidc_mock_test.yaml`: delete every `      profile: local` line; in the three "absent in production" tests replace the three `set:` lines (`profile: production`, `existingSecret: corp-secrets`, `oidc.issuer: https://idp.corp.example.com`) with `      oidcMock.enabled: false`, and rename them `is absent when oidcMock is disabled`, `service absent when oidcMock is disabled`, `configmap absent when oidcMock is disabled`. Rename `creates deployment in local profile` → `creates deployment by default` and `creates service in local profile` → `creates service by default`. Append:

```yaml
  - it: builds clients and users from oidcMock values only
    template: templates/oidc-mock-configmap.yaml
    set:
      oidcMock.clients.web.id: mock-web
      oidcMock.clients.web.secret: mock-secret
      oidcMock.clients.web.redirectUris: [https://a.example.com/cb, https://b.example.com/cb]
      oidcMock.clients.cli.id: mock-cli
      oidcMock.users: [{sub: u9, email: carol@example.com, name: Carol, password: pw}]
      oidc.clientId: ignored-web
      oidc.cliClientId: ignored-cli
      oidc.redirectUri: https://ignored.example.com/cb
      secrets.oidcClientSecret: ignored-secret
    asserts:
      - matchRegex:
          path: data["oidc-config.yaml"]
          pattern: "- id: mock-web\n    secret: mock-secret\n    redirect_uris:\n      - https://a.example.com/cb\n      - https://b.example.com/cb\n"
      - matchRegex:
          path: data["oidc-config.yaml"]
          pattern: "- id: mock-cli\n    redirect_uris:\n      - http://127.0.0.1:0/callback\n"
      - matchRegex:
          path: data["oidc-config.yaml"]
          pattern: "carol@example.com"
      - matchRegex:
          path: data["oidc-config.yaml"]
          pattern: "password: pw"
      - notMatchRegex:
          path: data["oidc-config.yaml"]
          pattern: "ignored|alice@example.com"

  - it: defaults the web client redirect URI to the API callback, ignoring oidc.redirectUri
    template: templates/oidc-mock-configmap.yaml
    set:
      api.publicUrl: https://api.example.com
      oidc.redirectUri: https://ignored.example.com/cb
    asserts:
      - matchRegex:
          path: data["oidc-config.yaml"]
          pattern: "- https://api.example.com/auth/callback\n"
```

Replace the last test (`keeps the in-cluster issuer when a real IdP is configured`) with:

```yaml
  - it: advertises its exposed host even when oidc.issuer is set
    template: templates/oidc-mock-configmap.yaml
    set:
      expose.type: ingress
      expose.host: example.com
      oidc.issuer: https://idp.corp.example.com
    asserts:
      - matchRegex:
          path: data["oidc-config.yaml"]
          pattern: "issuer: https://RELEASE-NAME-oidc.example.com\n"
```

In `tests/ingress_test.yaml`: rename `routes the oidc-mock host to the oidc-mock service in the local profile` → `routes the oidc-mock host to the oidc-mock service`; in `has no oidc-mock rule in the production profile` replace its three `set:` lines with `      oidcMock.enabled: false` and rename it `has no oidc-mock rule when oidcMock is disabled`; replace the test `has no oidc-mock rule when a real IdP is configured in the local profile` with:

```yaml
  - it: keeps the oidc-mock rule when oidc.issuer is set
    set:
      oidc.issuer: https://idp.corp.example.com
    asserts:
      - lengthEqual:
          path: spec.rules
          count: 3
      - contains:
          path: spec.rules
          content:
            host: RELEASE-NAME-oidc.example.com
          any: true
```

In `tests/virtualservice_test.yaml`: rename `renders api, ui and oidc-mock VirtualServices in the local profile` → `renders api, ui and oidc-mock VirtualServices`; in `renders only the api VirtualService with ui disabled in production` and `omits the oidc-mock VirtualService in production` replace `profile: production` / `existingSecret: corp-secrets` / `oidc.issuer: https://idp.corp.example.com` with `      oidcMock.enabled: false` and rename them `renders only the api VirtualService with ui and oidcMock disabled` / `omits the oidc-mock VirtualService when oidcMock is disabled`; replace `omits the oidc-mock VirtualService when a real IdP is configured in the local profile` with:

```yaml
  - it: keeps the oidc-mock VirtualService when oidc.issuer is set
    set:
      oidc.issuer: https://idp.corp.example.com
    asserts:
      - hasDocuments:
          count: 3
      - equal:
          path: metadata.name
          value: RELEASE-NAME-opencode-rc-oidc-mock
        documentIndex: 2
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `helm unittest charts/opencode-rc`
Expected: FAIL in `oidc mock`, `ingress`, `virtualservice` (disabled-mock cases still render; new clients test fails; `oidc.issuer` cases omit the mock).

- [ ] **Step 4: Implement**

`values.yaml`, oidcMock block becomes:

```yaml
oidcMock:
  # Deploy the bundled OIDC mock (dev/test IdP). Empty oidc.* values default to it.
  enabled: true
  # External URL for oidc-mock (e.g. https://oidc-mock.corp.example.com). Defaults to
  # {expose.scheme}://{release}-oidc.{expose.host} when exposed, else the internal service URL.
  issuer: ""
  clients:
    web:
      id: opencode-rc
      secret: opencode-rc-secret
      # Empty: <api public URL>/auth/callback
      redirectUris: []
    cli:
      id: opencode-rc-cli
      redirectUris: ["http://127.0.0.1:0/callback"]
  users:
    - sub: user1
      email: alice@example.com
      name: Alice
    - sub: user2
      email: bob@example.com
      name: Bob
  image:
```

(keep the rest of the block from `image:` on unchanged). In the `expose` comment change `bundled oidc-mock (profile local only)` → `bundled oidc-mock (oidcMock.enabled)`.

`_helpers.tpl`, replace the `oidcMockExposed` definition and its comment with:

```
{{/*
"true" when the bundled oidc-mock gets its own exposed host.
*/}}
{{- define "opencode-rc.oidcMockExposed" -}}
{{- if and .Values.oidcMock.enabled (ne (include "opencode-rc.exposeType" .) "none") -}}
true
{{- end -}}
{{- end -}}
```

`oidc-mock-deployment.yaml` and `oidc-mock-service.yaml` line 1: `{{- if .Values.oidcMock.enabled }}`.

`oidc-mock-configmap.yaml` becomes:

```yaml
{{- if .Values.oidcMock.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "opencode-rc.fullname" . }}-oidc-mock
  labels:
    {{- include "opencode-rc.labels" . | nindent 4 }}
    app.kubernetes.io/component: oidc-mock
data:
  oidc-config.yaml: |
    port: 8080
    issuer: {{ include "opencode-rc.oidcMockIssuer" . }}
    clients:
    {{- with .Values.oidcMock.clients.web }}
      - id: {{ .id }}
        secret: {{ .secret }}
        redirect_uris:
        {{- range .redirectUris | default (list (printf "%s/auth/callback" (include "opencode-rc.apiPublicUrl" $))) }}
          - {{ . }}
        {{- end }}
    {{- end }}
    {{- with .Values.oidcMock.clients.cli }}
      - id: {{ .id }}
        redirect_uris:
        {{- range .redirectUris }}
          - {{ . }}
        {{- end }}
    {{- end }}
    users:
      {{- toYaml .Values.oidcMock.users | nindent 6 }}
{{- end }}
```

The Step 2 regexes assume the data (block scalar, dedented) lists clients as `  - id: ...` under `clients:`. If a regex fails only on whitespace, render with `helm template t charts/opencode-rc -s templates/oidc-mock-configmap.yaml` and align the regex to the real indentation; the default render must stay identical to the pre-change output apart from the users' key order.

- [ ] **Step 5: Run tests to verify they pass**

Run: `helm unittest charts/opencode-rc`
Expected: all suites PASS (tests that still set `profile` are unaffected: `profile` no longer gates the mock, but the helpers still read it until Task 3).

- [ ] **Step 6: Commit**

```bash
git add charts/opencode-rc
git commit -m "feat(chart): self-contained oidc-mock with oidcMock.enabled"
```

---

### Task 2: `oidc.*` and the client secret default from the mock

**Files:**
- Modify: `charts/opencode-rc/values.yaml` (`oidc.clientId`, `oidc.cliClientId`, `secrets.oidcClientSecret`)
- Modify: `charts/opencode-rc/templates/_helpers.tpl` (`oidcIssuer`, `oidcMockSplit`, new `oidcClientId`, `oidcCliClientId`, `oidcClientSecret`)
- Modify: `charts/opencode-rc/templates/api-deployment.yaml`, `gateway-deployment.yaml`, `secret.yaml`, `NOTES.txt`
- Test: `charts/opencode-rc/tests/api_deployment_test.yaml`, `gateway_deployment_test.yaml`, `secret_test.yaml`

**Interfaces:**
- Consumes: `oidcMock.enabled`, `oidcMock.clients.*` (Task 1).
- Produces: helpers `opencode-rc.oidcClientId`, `opencode-rc.oidcCliClientId`, `opencode-rc.oidcClientSecret` (strings); `opencode-rc.oidcIssuer` fails with `oidc.issuer is required unless oidcMock.enabled`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api_deployment_test.yaml`:

```yaml
  - it: takes client ids from the mock when oidc.* is empty
    set:
      oidcMock.clients.web.id: mock-web
      oidcMock.clients.cli.id: mock-cli
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLIENT_ID, value: mock-web}
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLI_CLIENT_ID, value: mock-cli}

  - it: explicit oidc client ids win over the mock
    set:
      oidcMock.clients.web.id: mock-web
      oidc.clientId: corp-web
      oidc.cliClientId: corp-cli
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLIENT_ID, value: corp-web}
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLI_CLIENT_ID, value: corp-cli}

  - it: uses built-in client ids with the mock disabled
    set:
      oidcMock.enabled: false
      oidc.issuer: https://idp.corp.example.com
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLIENT_ID, value: opencode-rc}
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLI_CLIENT_ID, value: opencode-rc-cli}

  - it: discovers the mock in-cluster when oidcMock.issuer is set
    set:
      oidcMock.issuer: http://mock.example.com:30080
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_ISSUER, value: "http://RELEASE-NAME-opencode-rc-oidc-mock:8080"}
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_ISSUER_OVERRIDE, value: "http://mock.example.com:30080"}
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_AUTHORIZATION_ENDPOINT, value: "http://mock.example.com:30080/authorize"}
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_TOKEN_ENDPOINT, value: "http://RELEASE-NAME-opencode-rc-oidc-mock:8080/token"}
```

Delete the existing test `an explicit oidcMock.issuer disables the derived oidc-mock overrides` (its expectation is the old behaviour this spec changes).

Append to `tests/gateway_deployment_test.yaml`:

```yaml
  - it: takes client ids from the mock when oidc.* is empty
    set:
      oidcMock.clients.web.id: mock-web
      oidcMock.clients.cli.id: mock-cli
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLIENT_ID, value: mock-web}
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: OIDC_CLI_CLIENT_ID, value: mock-cli}
```

Append to `tests/secret_test.yaml`:

```yaml
  - it: takes oidc-client-secret from the mock web client
    set:
      oidcMock.clients.web.secret: mock-secret
    asserts:
      - equal:
          path: stringData["oidc-client-secret"]
          value: mock-secret

  - it: secrets.oidcClientSecret wins over the mock
    set:
      oidcMock.clients.web.secret: mock-secret
      secrets.oidcClientSecret: corp-secret
    asserts:
      - equal:
          path: stringData["oidc-client-secret"]
          value: corp-secret

  - it: leaves oidc-client-secret empty with the mock disabled
    set:
      oidcMock.enabled: false
      oidc.issuer: https://idp.corp.example.com
    asserts:
      - equal:
          path: stringData["oidc-client-secret"]
          value: ""
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `helm unittest charts/opencode-rc`
Expected: FAIL on the new cases (ids come from `oidc.*` defaults; secret from `secrets.oidcClientSecret`; no split with `oidcMock.issuer`).

- [ ] **Step 3: Implement**

`values.yaml`:

```yaml
oidc:
  # Required unless oidcMock.enabled; empty uses the mock's issuer.
  issuer: ""
  # Empty: oidcMock.clients.web.id when the mock is enabled, else opencode-rc.
  clientId: ""
  # Empty: oidcMock.clients.cli.id when the mock is enabled, else opencode-rc-cli.
  cliClientId: ""
```

(rest of `oidc` unchanged) and under `secrets`:

```yaml
  # Empty: oidcMock.clients.web.secret when the mock is enabled.
  oidcClientSecret: ""
```

`_helpers.tpl`: replace `oidcIssuer` and `oidcMockSplit` (with their comments) by:

```
{{/*
OIDC issuer: oidc.issuer, else the oidc-mock issuer when the mock is enabled.
*/}}
{{- define "opencode-rc.oidcIssuer" -}}
{{- if .Values.oidc.issuer -}}
  {{- .Values.oidc.issuer -}}
{{- else if .Values.oidcMock.enabled -}}
  {{- include "opencode-rc.oidcMockIssuer" . -}}
{{- else -}}
  {{- fail "oidc.issuer is required unless oidcMock.enabled" -}}
{{- end -}}
{{- end }}

{{/*
"true" when the api and gateway use the mock through an issuer other than its in-cluster
URL (exposed host or oidcMock.issuer). They then discover the mock in-cluster and override
the external parts: the mock advertises every endpoint under its external issuer.
*/}}
{{- define "opencode-rc.oidcMockSplit" -}}
{{- if and .Values.oidcMock.enabled (not .Values.oidc.issuer) (ne (include "opencode-rc.oidcMockIssuer" .) (include "opencode-rc.oidcMockServiceUrl" .)) -}}
true
{{- end -}}
{{- end -}}

{{/*
OIDC client ids and web client secret: explicit value, else the oidc-mock's client when
the mock is enabled, else the built-in id (secret: empty).
*/}}
{{- define "opencode-rc.oidcClientId" -}}
{{- if .Values.oidc.clientId -}}
{{- .Values.oidc.clientId -}}
{{- else if .Values.oidcMock.enabled -}}
{{- .Values.oidcMock.clients.web.id -}}
{{- else -}}
opencode-rc
{{- end -}}
{{- end -}}

{{- define "opencode-rc.oidcCliClientId" -}}
{{- if .Values.oidc.cliClientId -}}
{{- .Values.oidc.cliClientId -}}
{{- else if .Values.oidcMock.enabled -}}
{{- .Values.oidcMock.clients.cli.id -}}
{{- else -}}
opencode-rc-cli
{{- end -}}
{{- end -}}

{{- define "opencode-rc.oidcClientSecret" -}}
{{- if .Values.secrets.oidcClientSecret -}}
{{- .Values.secrets.oidcClientSecret -}}
{{- else if .Values.oidcMock.enabled -}}
{{- .Values.oidcMock.clients.web.secret -}}
{{- end -}}
{{- end -}}
```

`api-deployment.yaml` and `gateway-deployment.yaml`: replace `{{ .Values.oidc.clientId | quote }}` with `{{ include "opencode-rc.oidcClientId" . | quote }}` and `{{ .Values.oidc.cliClientId | quote }}` with `{{ include "opencode-rc.oidcCliClientId" . | quote }}`.

`secret.yaml`: `oidc-client-secret: {{ include "opencode-rc.oidcClientSecret" . | quote }}`.

`NOTES.txt`: `OIDC_CLIENT_ID={{ include "opencode-rc.oidcCliClientId" . }}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `helm unittest charts/opencode-rc`
Expected: PASS. Existing `profile: production` tests still pass (they set `oidc.issuer`; `profile` no longer affects the issuer only once Task 3 lands, but `oidcMock.enabled` is still true there, so the issuer comes from `oidc.issuer` either way).

- [ ] **Step 5: Commit**

```bash
git add charts/opencode-rc
git commit -m "feat(chart): oidc client ids, secret and issuer default from the mock"
```

---

### Task 3: Remove `profile`; Secret by `existingSecret`; derived `COOKIE_SECURE`

**Files:**
- Modify: `charts/opencode-rc/values.yaml` (line 1 `profile`, `api.cookieSecure`)
- Modify: `charts/opencode-rc/templates/_helpers.tpl` (drop `validateProduction`, add `cookieSecure`)
- Modify: `charts/opencode-rc/templates/api-deployment.yaml:1,66-67`, `gateway-deployment.yaml:1`, `secret.yaml:1`, `NOTES.txt:3`
- Delete: `charts/opencode-rc/tests/profile_validation_test.yaml`
- Create: `charts/opencode-rc/tests/oidc_validation_test.yaml`
- Test: `api_deployment_test.yaml`, `gateway_deployment_test.yaml`, `secret_test.yaml`, `image_helpers_test.yaml`

**Interfaces:**
- Consumes: `opencode-rc.oidcIssuer` failure message (Task 2), `opencode-rc.apiPublicUrl`.
- Produces: helper `opencode-rc.cookieSecure` → `"true"` | `"false"`; value `api.cookieSecure` (null | bool).

- [ ] **Step 1: Write the failing tests**

Replace every remaining `profile` in tests:

```bash
cd charts/opencode-rc
sed -i '/^      profile: local$/d' tests/*.yaml
sed -i 's/^      profile: production$/      oidcMock.enabled: false/' tests/*.yaml
grep -rn "profile" tests/   # expect only profile_validation_test.yaml
git rm -q tests/profile_validation_test.yaml
```

Create `tests/oidc_validation_test.yaml`:

```yaml
suite: oidc validation
templates:
  - templates/api-deployment.yaml
tests:
  - it: fails without oidc.issuer when the mock is disabled
    set:
      oidcMock.enabled: false
    asserts:
      - failedTemplate:
          errorMessage: "oidc.issuer is required unless oidcMock.enabled"

  - it: renders with the mock disabled and oidc.issuer set, without existingSecret
    set:
      oidcMock.enabled: false
      oidc.issuer: https://idp.corp.example.com
    asserts:
      - isKind:
          of: Deployment

  - it: renders with default values
    asserts:
      - isKind:
          of: Deployment
```

In `tests/secret_test.yaml` replace the first two tests with:

```yaml
  - it: creates the secret without existingSecret
    asserts:
      - isKind:
          of: Secret
      - equal:
          path: metadata.name
          value: RELEASE-NAME-opencode-rc
      - equal:
          path: stringData["cookie-secret"]
          value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      - equal:
          path: stringData["oidc-client-secret"]
          value: "opencode-rc-secret"
      - equal:
          path: stringData["redis-url"]
          value: "redis://RELEASE-NAME-opencode-rc-redis:6379/0"

  - it: is absent with existingSecret
    set:
      existingSecret: corp-secrets
    asserts:
      - hasDocuments:
          count: 0
```

In `tests/api_deployment_test.yaml` replace the two `COOKIE_SECURE` tests with:

```yaml
  - it: sets COOKIE_SECURE to false for the in-cluster http API URL
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: COOKIE_SECURE, value: "false"}

  - it: sets COOKIE_SECURE to true for an https API URL
    set:
      expose.type: ingress
      expose.host: example.com
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: COOKIE_SECURE, value: "true"}

  - it: sets COOKIE_SECURE to false for an http api.publicUrl
    set:
      api.publicUrl: http://api.example.com:30080
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: COOKIE_SECURE, value: "false"}

  - it: api.cookieSecure overrides the derived value
    set:
      expose.type: ingress
      expose.host: example.com
      api.cookieSecure: false
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: COOKIE_SECURE, value: "false"}

  - it: api.cookieSecure true forces Secure over http
    set:
      api.cookieSecure: true
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: {name: COOKIE_SECURE, value: "true"}
```

Rename leftover test titles that mention profiles, for example:

```bash
sed -i -e 's/ in production profile$//' -e 's/ in production$//' -e 's/^  - it: production with expose/  - it: a configured issuer with expose/' tests/*.yaml
grep -rn "production\|local profile" tests/
```

Fix any remaining hits by hand so titles describe the set values (e.g. `uses existingSecret`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `helm unittest charts/opencode-rc`
Expected: FAIL: secret still rendered with `existingSecret` (gated on `profile`), `COOKIE_SECURE` https case, `api.cookieSecure` cases.

- [ ] **Step 3: Implement**

`values.yaml`: delete line 1 (`profile: local  # or "production"`) and the blank line after it. Under `api:` after `publicUrl: ""`:

```yaml
  # Secure flag of the short-lived login cookies. null: true iff the API public URL is https.
  cookieSecure: null
```

`_helpers.tpl`: delete the `validateProduction` definition and its comment. Add:

```
{{/*
COOKIE_SECURE: api.cookieSecure when set, else whether the API public URL is https.
*/}}
{{- define "opencode-rc.cookieSecure" -}}
{{- $v := .Values.api.cookieSecure -}}
{{- if kindIs "bool" $v -}}
{{- $v -}}
{{- else -}}
{{- hasPrefix "https://" (include "opencode-rc.apiPublicUrl" .) -}}
{{- end -}}
{{- end -}}
```

`api-deployment.yaml`: delete line 1 (`{{- include "opencode-rc.validateProduction" . -}}`); replace the `COOKIE_SECURE` value with `value: {{ include "opencode-rc.cookieSecure" . | quote }}`.

`gateway-deployment.yaml`: delete line 1 (`validateProduction` include).

`secret.yaml` line 1: `{{- if not .Values.existingSecret }}`.

`NOTES.txt`: delete line 3 (`Profile: ...`) and the blank line before it if two blank lines remain.

- [ ] **Step 4: Run tests and check nothing references profile**

Run: `helm unittest charts/opencode-rc && grep -rn "profile" charts/opencode-rc`
Expected: all PASS; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add -A charts/opencode-rc
git commit -m "feat(chart)!: replace profile with explicit components"
```

---

### Task 4: Docs, e2e and a manual check

**Files:**
- Modify: `README.md` (install examples, host table, values table, "Local Profile" section)

- [ ] **Step 1: Update README**

Install examples (both): replace `--set profile=production \` with `--set oidcMock.enabled=false \`; drop the two `--set oidc.clientId` / `--set oidc.cliClientId` lines (the defaults are the same ids).

Host table row: `| `{release}-oidc.{host}` (e.g. `opencode-rc-oidc.example.com`) | bundled oidc-mock (when `oidcMock.enabled`) |`

Values table: delete the `profile` row; replace the `oidc.*` rows and add rows:

```markdown
| `oidcMock.enabled` | `true` | Deploy the bundled OIDC mock; empty `oidc.*` values default to it |
| `oidcMock.clients` | web `opencode-rc`, cli `opencode-rc-cli` | Mock clients (`id`, `secret`, `redirectUris`); web redirect defaults to `<api public URL>/auth/callback` |
| `oidcMock.users` | alice, bob | Mock users |
| `oidc.issuer` | `""` | OIDC provider URL; required unless `oidcMock.enabled` |
| `oidc.clientId` | `""` | Web client ID; empty: the mock's web client, else `opencode-rc` |
| `oidc.cliClientId` | `""` | CLI client ID; empty: the mock's CLI client, else `opencode-rc-cli` |
| `api.cookieSecure` | `null` | Secure flag of the login cookies; null: true iff the API public URL is https |
```

In the `expose.host` row replace `for `profile=local`` with `with `oidcMock.enabled``.

Replace the `### Local Profile` section (heading through the `oidcMock.issuer` example) with:

````markdown
### Bundled OIDC Mock

By default the chart deploys an OIDC mock with test users (alice/bob) and a built-in Redis, so it runs without external dependencies:

```bash
helm install opencode-rc ./charts/opencode-rc
```

The mock is configured by `oidcMock.*` only. Empty `oidc.*` values default to it: the issuer, the client ids and the web client secret. With `expose.type` set, it is exposed on `{release}-oidc.{host}` with that host as its issuer; set `oidcMock.issuer` when browsers reach it at another URL. The API and the gateway always talk to it in-cluster.

For a real IdP, set `oidcMock.enabled=false`, `oidc.issuer` and `existingSecret`. Without `existingSecret` the chart renders a Secret from `secrets.*`, whose defaults are for development only.
````

- [ ] **Step 2: Unit tests and e2e**

```bash
make unit-test
KUBE_CONTEXT=kind-gen1 NAMESPACE=opencode-rc-e2e make up
KUBE_CONTEXT=kind-gen1 NAMESPACE=opencode-rc-e2e make e2e-test
```

Expected: all unit tests pass; e2e: vitest 50 passed, playwright 14 passed (the default values give the same deployment as before).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe oidcMock.* and explicit chart components"
```

- [ ] **Step 4: Manual check from the host (not committed)**

Deploy the e2e namespace with a values file that sets only `expose.*` (virtualService on the host's Istio gateway, `scheme: http`), `api.publicUrl`, `ui.publicUrl` and `oidcMock.issuer` with the NodePort, then sign in from a host browser and confirm the redirect chain reaches the UI's session picker. Keep those values and hostnames out of the repository.
