{{/*
Chart name.
*/}}
{{- define "opencode-rc.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name. Truncated to 63 chars.
*/}}
{{- define "opencode-rc.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label value.
*/}}
{{- define "opencode-rc.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "opencode-rc.labels" -}}
helm.sh/chart: {{ include "opencode-rc.chart" . }}
{{ include "opencode-rc.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "opencode-rc.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opencode-rc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Build image reference from component image config.
Usage: {{ include "opencode-rc.image" (dict "image" .Values.api.image "global" .Values.global) }}
*/}}
{{- define "opencode-rc.image" -}}
{{- $registry := .image.registry -}}
{{- if and .global .global.imageRegistry -}}
  {{- $registry = .global.imageRegistry -}}
{{- end -}}
{{- if $registry -}}
  {{- printf "%s/%s:%s" $registry .image.repository .image.tag -}}
{{- else -}}
  {{- printf "%s:%s" .image.repository .image.tag -}}
{{- end -}}
{{- end }}

{{/*
Secret name — existingSecret if set, else chart-generated secret.
*/}}
{{- define "opencode-rc.secretName" -}}
{{- if .Values.existingSecret -}}
  {{- .Values.existingSecret -}}
{{- else -}}
  {{- include "opencode-rc.fullname" . -}}
{{- end -}}
{{- end }}

{{/*
Redis URL — internal service URL when redis.enabled, else empty (read from secret).
*/}}
{{- define "opencode-rc.redisUrl" -}}
{{- if .Values.redis.enabled -}}
  redis://{{ include "opencode-rc.fullname" . }}-redis:6379/0
{{- end -}}
{{- end }}

{{/*
How the chart is exposed: none | ingress | virtualService ("none" when expose is unset,
e.g. an upgrade with --reuse-values from a chart without expose.*).
*/}}
{{- define "opencode-rc.exposeType" -}}
{{- dig "type" "none" (.Values.expose | default dict) -}}
{{- end -}}

{{/*
Exposed hosts, derived from the release name and expose.host.
*/}}
{{- define "opencode-rc.apiHost" -}}
{{- printf "%s.%s" .Release.Name .Values.expose.host -}}
{{- end -}}

{{- define "opencode-rc.uiHost" -}}
{{- printf "%s-ui.%s" .Release.Name .Values.expose.host -}}
{{- end -}}

{{- define "opencode-rc.oidcMockHost" -}}
{{- printf "%s-oidc.%s" .Release.Name .Values.expose.host -}}
{{- end -}}

{{/*
"true" when the bundled oidc-mock (profile local) gets its own exposed host.
*/}}
{{- define "opencode-rc.oidcMockExposed" -}}
{{- if and (eq .Values.profile "local") (ne (include "opencode-rc.exposeType" .) "none") -}}
true
{{- end -}}
{{- end -}}

{{- define "opencode-rc.oidcMockServiceUrl" -}}
http://{{ include "opencode-rc.fullname" . }}-oidc-mock:8080
{{- end -}}

{{/*
Issuer the oidc-mock advertises: oidcMock.issuer, else its exposed host, else its service URL.
*/}}
{{- define "opencode-rc.oidcMockIssuer" -}}
{{- if .Values.oidcMock.issuer -}}
{{ .Values.oidcMock.issuer }}
{{- else if include "opencode-rc.oidcMockExposed" . -}}
{{ .Values.expose.scheme }}://{{ include "opencode-rc.oidcMockHost" . }}
{{- else -}}
{{ include "opencode-rc.oidcMockServiceUrl" . }}
{{- end -}}
{{- end -}}

{{/*
OIDC Issuer — explicit value, or the oidc-mock issuer in local profile.
*/}}
{{- define "opencode-rc.oidcIssuer" -}}
{{- if .Values.oidc.issuer -}}
  {{- .Values.oidc.issuer -}}
{{- else if eq .Values.profile "local" -}}
  {{- include "opencode-rc.oidcMockIssuer" . -}}
{{- else -}}
  {{- fail "oidc.issuer is required when profile is production" -}}
{{- end -}}
{{- end }}

{{/*
"true" when the issuer is the derived external oidc-mock host (exposed, no explicit
oidc.issuer / oidcMock.issuer). Servers then discover the mock in-cluster and override
the external parts: the mock advertises every endpoint under its external issuer.
*/}}
{{- define "opencode-rc.oidcMockSplit" -}}
{{- if and (include "opencode-rc.oidcMockExposed" .) (not .Values.oidc.issuer) (not .Values.oidcMock.issuer) -}}
true
{{- end -}}
{{- end -}}

{{/*
OIDC_ISSUER for the api and gateway: the URL they fetch discovery from.
*/}}
{{- define "opencode-rc.oidcDiscoveryIssuer" -}}
{{- if include "opencode-rc.oidcMockSplit" . -}}
{{ include "opencode-rc.oidcMockServiceUrl" . }}
{{- else -}}
{{ include "opencode-rc.oidcIssuer" . }}
{{- end -}}
{{- end -}}

{{/*
OIDC discovery override env vars for the api and gateway. Explicit oidc.* values win;
with the derived external oidc-mock issuer: iss and the browser authorize URL are
external, token and jwks stay in-cluster.
*/}}
{{- define "opencode-rc.oidcOverrideEnv" -}}
{{- $split := include "opencode-rc.oidcMockSplit" . -}}
{{- $issuer := "" -}}
{{- $authorize := "" -}}
{{- $token := "" -}}
{{- $jwks := "" -}}
{{- if $split -}}
{{- $issuer = include "opencode-rc.oidcIssuer" . -}}
{{- $authorize = printf "%s/authorize" $issuer -}}
{{- $token = printf "%s/token" (include "opencode-rc.oidcMockServiceUrl" .) -}}
{{- $jwks = printf "%s/jwks" (include "opencode-rc.oidcMockServiceUrl" .) -}}
{{- end -}}
{{- with .Values.oidc.issuerOverride | default $issuer }}
- name: OIDC_ISSUER_OVERRIDE
  value: {{ . | quote }}
{{- end }}
{{- with .Values.oidc.authorizationEndpoint | default $authorize }}
- name: OIDC_AUTHORIZATION_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with .Values.oidc.tokenEndpoint | default $token }}
- name: OIDC_TOKEN_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with .Values.oidc.jwksUri | default $jwks }}
- name: OIDC_JWKS_URI
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{/*
OIDC Redirect URI — explicit value, else <api public URL>/auth/callback.
*/}}
{{- define "opencode-rc.redirectUri" -}}
{{- if .Values.oidc.redirectUri -}}
  {{- .Values.oidc.redirectUri -}}
{{- else -}}
  {{- include "opencode-rc.apiPublicUrl" . }}/auth/callback
{{- end -}}
{{- end }}

{{/*
Public URL of a component: <component>.publicUrl if set (trailing slash trimmed),
else {expose.scheme}://<derived host> when exposed, else the in-cluster service URL.
*/}}
{{- define "opencode-rc.apiServiceUrl" -}}
http://{{ include "opencode-rc.fullname" . }}-api:8080
{{- end -}}

{{- define "opencode-rc.apiPublicUrl" -}}
{{- if .Values.api.publicUrl -}}
{{ trimSuffix "/" .Values.api.publicUrl }}
{{- else if ne (include "opencode-rc.exposeType" .) "none" -}}
{{ .Values.expose.scheme }}://{{ include "opencode-rc.apiHost" . }}
{{- else -}}
{{ include "opencode-rc.apiServiceUrl" . }}
{{- end -}}
{{- end -}}

{{- define "opencode-rc.uiPublicUrl" -}}
{{- if .Values.ui.publicUrl -}}
{{ trimSuffix "/" .Values.ui.publicUrl }}
{{- else if ne (include "opencode-rc.exposeType" .) "none" -}}
{{ .Values.expose.scheme }}://{{ include "opencode-rc.uiHost" . }}
{{- else -}}
http://{{ include "opencode-rc.fullname" . }}-ui:8080
{{- end -}}
{{- end -}}

{{/*
A UI reachable by browsers (ui.publicUrl) needs an API URL browsers can reach too.
With expose.type != none both are exposed.
*/}}
{{- define "opencode-rc.validateUiApiUrl" -}}
{{- if and .Values.ui.enabled .Values.ui.publicUrl (eq (include "opencode-rc.apiPublicUrl" .) (include "opencode-rc.apiServiceUrl" .)) -}}
{{- fail "ui.publicUrl is set but the API is not reachable by browsers: set expose.type and expose.host, or api.publicUrl" -}}
{{- end -}}
{{- end -}}

{{/*
Values web.* were renamed to api.* in 0.6; fail instead of silently ignoring them.
*/}}
{{- define "opencode-rc.validateNoLegacyWeb" -}}
{{- if .Values.web -}}
{{- fail "chart values web.* were renamed to api.* (see Upgrading to 0.6 in README)" -}}
{{- end -}}
{{- end -}}

{{/*
expose.* checks; per-component ingress values were replaced by expose.* in 0.6.
*/}}
{{- define "opencode-rc.validateExpose" -}}
{{- $type := include "opencode-rc.exposeType" . -}}
{{- if not (has $type (list "none" "ingress" "virtualService")) -}}
{{- fail (printf "expose.type must be one of none, ingress, virtualService (got %q)" $type) -}}
{{- end -}}
{{- if and (ne $type "none") (not .Values.expose.host) -}}
{{- fail (printf "expose.host is required when expose.type is %s" $type) -}}
{{- end -}}
{{- if and (eq $type "virtualService") (not .Values.expose.virtualService.gateways) -}}
{{- fail "expose.virtualService.gateways is required when expose.type is virtualService" -}}
{{- end -}}
{{- if or (hasKey .Values.api "ingress") (hasKey .Values.ui "ingress") (hasKey .Values.gateway "ingress") -}}
{{- fail "per-component ingress settings (api.ingress, ui.ingress, gateway.ingress) were replaced by expose.* (see Upgrading to 0.6 in README)" -}}
{{- end -}}
{{- end -}}

{{/*
Validation — production profile checks.
*/}}
{{- define "opencode-rc.validateProduction" -}}
{{- if eq .Values.profile "production" -}}
  {{- if not .Values.existingSecret -}}
    {{- fail "existingSecret is required when profile is production" -}}
  {{- end -}}
{{- end -}}
{{- end }}
