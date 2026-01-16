{{/*
Expand the name of the chart.
*/}}
{{- define "crowdsieve.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "crowdsieve.fullname" -}}
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
Create chart name and version as used by the chart label.
*/}}
{{- define "crowdsieve.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "crowdsieve.labels" -}}
helm.sh/chart: {{ include "crowdsieve.chart" . }}
{{ include "crowdsieve.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "crowdsieve.selectorLabels" -}}
app.kubernetes.io/name: {{ include "crowdsieve.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "crowdsieve.serviceAccountName" -}}
{{- if .Values.crowdsieve.serviceAccount.create }}
{{- default (include "crowdsieve.fullname" .) .Values.crowdsieve.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.crowdsieve.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
CrowdSieve image
*/}}
{{- define "crowdsieve.image" -}}
{{- $tag := .Values.crowdsieve.image.tag | default .Chart.AppVersion }}
{{- printf "%s:%s" .Values.crowdsieve.image.repository $tag }}
{{- end }}

{{/*
CrowdSieve internal service URL (for CrowdSec LAPI to connect to)
*/}}
{{- define "crowdsieve.internalUrl" -}}
{{- printf "http://%s:%d/" (include "crowdsieve.fullname" .) (int .Values.crowdsieve.service.proxyPort) }}
{{- end }}

{{/*
Dashboard API key - use provided value or generate a random one.
NOTE: When auto-generating, a new key is created on each helm upgrade unless
the user provides their own value. For persistent auto-generated keys,
users should set the key explicitly after initial deployment.
*/}}
{{- define "crowdsieve.dashboardApiKey" -}}
{{- if .Values.crowdsieve.dashboard.apiKey -}}
{{- .Values.crowdsieve.dashboard.apiKey -}}
{{- else -}}
{{- /* Generate a random 32-character alphanumeric key */ -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}

{{/*
Validate CrowdSieve configuration
*/}}
{{- define "crowdsieve.validateConfig" -}}
{{- if .Values.crowdsieve.enabled }}
{{- if and (gt (int .Values.crowdsieve.replicaCount) 1) (ne .Values.crowdsieve.storage.type "postgres") }}
{{- fail "CrowdSieve: replicaCount > 1 requires PostgreSQL. Set crowdsieve.storage.type=postgres or use replicaCount=1 with SQLite." }}
{{- end }}
{{- if eq .Values.crowdsieve.storage.type "postgres" }}
{{- $pg := .Values.crowdsieve.storage.postgres }}
{{- if not $pg.host }}
{{- fail "CrowdSieve: crowdsieve.storage.postgres.host is required when using PostgreSQL." }}
{{- end }}
{{- if not $pg.database }}
{{- fail "CrowdSieve: crowdsieve.storage.postgres.database is required when using PostgreSQL." }}
{{- end }}
{{- if not $pg.user }}
{{- fail "CrowdSieve: crowdsieve.storage.postgres.user is required when using PostgreSQL." }}
{{- end }}
{{- if and (not $pg.password) (not $pg.existingSecret) }}
{{- fail "CrowdSieve: crowdsieve.storage.postgres.password or crowdsieve.storage.postgres.existingSecret is required when using PostgreSQL." }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Validate CrowdSec LAPI configuration
*/}}
{{- define "crowdsieve.validateCrowdsecConfig" -}}
{{- if and .Values.crowdsec.enabled .Values.crowdsec.lapi.enabled }}
{{- if and (gt (int .Values.crowdsec.lapi.replicas) 1) (ne (default "sqlite" .Values.crowdsec.lapi.database.type) "postgres") }}
{{- fail "CrowdSec LAPI: replicas > 1 requires PostgreSQL. Set crowdsec.lapi.database.type=postgres or use replicas=1 with SQLite." }}
{{- end }}
{{- if eq (default "sqlite" .Values.crowdsec.lapi.database.type) "postgres" }}
{{- $pg := .Values.crowdsec.lapi.database.postgres }}
{{- if not $pg.host }}
{{- fail "CrowdSec LAPI: crowdsec.lapi.database.postgres.host is required when using PostgreSQL." }}
{{- end }}
{{- if not $pg.database }}
{{- fail "CrowdSec LAPI: crowdsec.lapi.database.postgres.database is required when using PostgreSQL." }}
{{- end }}
{{- if not $pg.user }}
{{- fail "CrowdSec LAPI: crowdsec.lapi.database.postgres.user is required when using PostgreSQL." }}
{{- end }}
{{- if and (not $pg.password) (not $pg.existingSecret) }}
{{- fail "CrowdSec LAPI: crowdsec.lapi.database.postgres.password or crowdsec.lapi.database.postgres.existingSecret is required when using PostgreSQL." }}
{{- end }}
{{- /* Check that DB_PASSWORD env var is configured */ -}}
{{- $hasDbPassword := false }}
{{- range .Values.crowdsec.lapi.env }}
{{- if eq .name "DB_PASSWORD" }}
{{- $hasDbPassword = true }}
{{- end }}
{{- end }}
{{- if not $hasDbPassword }}
{{- fail "CrowdSec LAPI: when using PostgreSQL, you must configure DB_PASSWORD in crowdsec.lapi.env. See values-postgres.yaml for a complete example." }}
{{- end }}
{{- /* Check that db-config volume mount is configured */ -}}
{{- $hasDbConfigMount := false }}
{{- range .Values.crowdsec.lapi.extraVolumeMounts }}
{{- if eq .mountPath "/etc/crowdsec/config.yaml.local" }}
{{- $hasDbConfigMount = true }}
{{- end }}
{{- end }}
{{- if not $hasDbConfigMount }}
{{- fail "CrowdSec LAPI: when using PostgreSQL, you must configure extraVolumeMounts to mount db-config at /etc/crowdsec/config.yaml.local. See values-postgres.yaml for a complete example." }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
