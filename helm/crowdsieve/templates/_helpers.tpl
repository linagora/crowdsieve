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
