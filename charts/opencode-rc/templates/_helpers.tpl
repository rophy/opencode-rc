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
OIDC Issuer — explicit value, or oidc-mock service URL in local profile.
*/}}
{{- define "opencode-rc.oidcIssuer" -}}
{{- if .Values.oidc.issuer -}}
  {{- .Values.oidc.issuer -}}
{{- else if eq .Values.profile "local" -}}
  {{- .Values.oidcMock.issuer | default (printf "http://%s-oidc-mock:8080" (include "opencode-rc.fullname" .)) -}}
{{- else -}}
  {{- fail "oidc.issuer is required when profile is production" -}}
{{- end -}}
{{- end }}

{{/*
OIDC Redirect URI — explicit value, or auto-derived from api ingress, or fallback to service.
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
else https://<host> with ingress+TLS, http://<host> with ingress, else the in-cluster service URL.
*/}}
{{- define "opencode-rc.apiServiceUrl" -}}
http://{{ include "opencode-rc.fullname" . }}-api:8080
{{- end -}}

{{- define "opencode-rc.apiPublicUrl" -}}
{{- if .Values.api.publicUrl -}}
{{ trimSuffix "/" .Values.api.publicUrl }}
{{- else if and .Values.api.ingress.enabled .Values.api.ingress.host -}}
{{ if .Values.api.ingress.tls }}https{{ else }}http{{ end }}://{{ .Values.api.ingress.host }}
{{- else -}}
{{ include "opencode-rc.apiServiceUrl" . }}
{{- end -}}
{{- end -}}

{{- define "opencode-rc.uiPublicUrl" -}}
{{- if .Values.ui.publicUrl -}}
{{ trimSuffix "/" .Values.ui.publicUrl }}
{{- else if and .Values.ui.ingress.enabled .Values.ui.ingress.host -}}
{{ if .Values.ui.ingress.tls }}https{{ else }}http{{ end }}://{{ .Values.ui.ingress.host }}
{{- else -}}
http://{{ include "opencode-rc.fullname" . }}-ui:8080
{{- end -}}
{{- end -}}

{{/*
A browser-facing UI (ui.ingress enabled) needs an API URL the browser can reach.
*/}}
{{- define "opencode-rc.validateUiApiUrl" -}}
{{- if and .Values.ui.enabled .Values.ui.ingress.enabled (eq (include "opencode-rc.apiPublicUrl" .) (include "opencode-rc.apiServiceUrl" .)) -}}
{{- fail "the UI needs a browser-reachable API URL: enable api.ingress or set api.publicUrl" -}}
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

{{- define "opencode-rc.validateHosts" -}}
{{- if and .Values.ui.ingress.enabled .Values.api.ingress.enabled (eq .Values.ui.ingress.host .Values.api.ingress.host) -}}
{{- fail "ui.ingress.host must differ from api.ingress.host: the API host must not serve the UI" -}}
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
