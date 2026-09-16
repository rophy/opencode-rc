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
Usage: {{ include "opencode-rc.image" (dict "image" .Values.web.image "global" .Values.global) }}
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
OIDC Redirect URI — explicit value, or auto-derived from web ingress, or fallback to service.
*/}}
{{- define "opencode-rc.redirectUri" -}}
{{- if .Values.oidc.redirectUri -}}
  {{- .Values.oidc.redirectUri -}}
{{- else if and .Values.web.ingress.enabled .Values.web.ingress.host -}}
  {{- if .Values.web.ingress.tls -}}
    https://{{ .Values.web.ingress.host }}/auth/callback
  {{- else -}}
    http://{{ .Values.web.ingress.host }}/auth/callback
  {{- end -}}
{{- else -}}
  http://{{ include "opencode-rc.fullname" . }}-web:8080/auth/callback
{{- end -}}
{{- end }}

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
