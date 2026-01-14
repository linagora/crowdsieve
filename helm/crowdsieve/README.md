# CrowdSieve Helm Chart

This Helm chart deploys [CrowdSieve](https://github.com/linagora/crowdsieve) with [CrowdSec](https://crowdsec.net/) on Kubernetes.

## Overview

CrowdSieve is a filtering proxy that sits between CrowdSec LAPI instances and the CrowdSec CAPI (Central API). It provides:

- **Alert filtering** before forwarding to CAPI
- **Local dashboard** for alert visualization
- **GeoIP enrichment** of alerts
- **Client validation** against CAPI
- **Data retention and archival**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  CrowdSec LAPI  │────▶│   CrowdSieve    │────▶│  CrowdSec CAPI  │
│    (Agent)      │     │  (Filter Proxy) │     │ (api.crowdsec.net)
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │    Dashboard    │
                        │   (Port 3000)   │
                        └─────────────────┘
```

## Prerequisites

- Kubernetes 1.19+
- Helm 3.2.0+
- PV provisioner support (for persistence)

## Installation

### Add the Helm repository

```bash
# If using a Helm repository
helm repo add crowdsieve https://your-helm-repo.example.com
helm repo update
```

### Install from local chart

```bash
# Clone the repository
git clone https://github.com/linagora/crowdsieve.git
cd crowdsieve

# Update dependencies
helm dependency update ./helm/crowdsieve

# Install the chart
helm install crowdsieve ./helm/crowdsieve -n security --create-namespace
```

### Install with custom values

```bash
helm install crowdsieve ./helm/crowdsieve \
  -f ./helm/crowdsieve/values-example.yaml \
  -n security --create-namespace
```

## Configuration

### Important: Configuring CrowdSec to use CrowdSieve

The CrowdSec LAPI needs to be configured to send alerts to CrowdSieve instead of the official CAPI. This is done by mounting a custom `online_api_credentials.yaml` file.

**Step 1:** Determine your release name (e.g., `crowdsieve`)

**Step 2:** Update your values to include the correct ConfigMap name:

```yaml
crowdsec:
  lapi:
    extraVolumeMounts:
      - name: online-api-credentials
        mountPath: /etc/crowdsec/online_api_credentials.yaml
        subPath: online_api_credentials.yaml
        readOnly: true

    extraVolumes:
      - name: online-api-credentials
        configMap:
          # Pattern: <release-name>-crowdsieve-capi-credentials
          name: crowdsieve-crowdsieve-capi-credentials
```

**Step 3:** Configure CAPI credentials:

```yaml
capiCredentials:
  login: "your-machine-id"
  password: "your-machine-password"
```

To get your credentials:
```bash
# Register with CrowdSec Central API
cscli capi register

# View your credentials
cat /etc/crowdsec/online_api_credentials.yaml
```

### Key Values

| Parameter | Description | Default |
|-----------|-------------|---------|
| `crowdsieve.enabled` | Enable CrowdSieve | `true` |
| `crowdsieve.proxy.capiUrl` | URL of CrowdSec CAPI | `https://api.crowdsec.net` |
| `crowdsieve.proxy.forwardEnabled` | Forward alerts to CAPI | `true` |
| `crowdsieve.dashboard.port` | Dashboard port | `3000` |
| `crowdsieve.dashboard.apiKey` | API key for dashboard auth | `""` |
| `crowdsieve.logging.level` | Log level | `info` |
| `crowdsieve.storage.type` | Storage backend: `sqlite` or `postgres` | `sqlite` |
| `crowdsieve.storage.retentionDays` | Alert retention days | `30` |
| `crowdsieve.storage.postgres.host` | PostgreSQL host | `""` |
| `crowdsieve.storage.postgres.port` | PostgreSQL port | `5432` |
| `crowdsieve.storage.postgres.database` | PostgreSQL database | `""` |
| `crowdsieve.storage.postgres.user` | PostgreSQL user | `""` |
| `crowdsieve.storage.postgres.password` | PostgreSQL password | `""` |
| `crowdsieve.storage.postgres.ssl` | Enable SSL | `false` |
| `crowdsieve.storage.postgres.existingSecret` | Use existing secret | `""` |
| `crowdsieve.geoip.enabled` | Enable GeoIP enrichment | `false` |
| `crowdsieve.geoip.maxmindLicenseKey` | MaxMind license key | `""` |
| `crowdsieve.persistence.enabled` | Enable persistence | `true` |
| `crowdsieve.persistence.size` | PVC size | `1Gi` |
| `crowdsieve.filters.mode` | Filter mode: `block` or `allow` | `block` |
| `crowdsieve.filters.rules` | Filter rules | See values.yaml |
| `crowdsec.enabled` | Enable CrowdSec subchart | `true` |
| `capiCredentials.login` | CrowdSec machine ID | `""` |
| `capiCredentials.password` | CrowdSec password | `""` |

### Filter Configuration

Filters are defined in `crowdsieve.filters.rules` as a map of filename to YAML content:

```yaml
crowdsieve:
  filters:
    mode: "block"  # "block" = matching alerts filtered, "allow" = only matching forwarded
    rules:
      # Block alerts without decisions
      00-no-decision.yaml: |
        name: "no-decision"
        description: "Block alerts without decisions"
        expression:
          empty:
            field: "decisions"

      # Block alerts from internal IPs
      10-internal-ips.yaml: |
        name: "internal-ips"
        description: "Block alerts from internal IP ranges"
        expression:
          or:
            - cidr:
                field: "source.ip"
                value: "10.0.0.0/8"
            - cidr:
                field: "source.ip"
                value: "192.168.0.0/16"
```

### PostgreSQL Backend

By default, CrowdSieve uses SQLite for storage. For production deployments with multiple replicas, you can use PostgreSQL instead.

#### Using PostgreSQL with password in values

```yaml
crowdsieve:
  replicaCount: 3  # Safe to scale with PostgreSQL
  storage:
    type: "postgres"
    postgres:
      host: "postgres.database.svc.cluster.local"
      port: 5432
      database: "crowdsieve"
      user: "crowdsieve"
      password: "your-secure-password"
      ssl: true
      sslRejectUnauthorized: true  # Set to false for self-signed certs
      poolSize: 10
```

#### Using PostgreSQL with existing secret

```yaml
crowdsieve:
  storage:
    type: "postgres"
    postgres:
      host: "postgres.database.svc.cluster.local"
      database: "crowdsieve"
      user: "crowdsieve"
      existingSecret: "my-postgres-credentials"
      passwordKey: "password"  # Key in the secret
```

**Note:** When using PostgreSQL, the PVC for SQLite is not needed:

```yaml
crowdsieve:
  persistence:
    enabled: false  # Not needed for PostgreSQL
```

### GeoIP Enrichment

To enable GeoIP enrichment, you need a MaxMind license key:

1. Sign up at https://www.maxmind.com/en/geolite2/signup
2. Generate a license key in your account
3. Add it to your values:

```yaml
crowdsieve:
  geoip:
    enabled: true
    maxmindLicenseKey: "your-license-key"
```

The GeoIP database will be downloaded automatically during pod initialization.

### Ingress

To expose the dashboard via Ingress:

```yaml
crowdsieve:
  ingress:
    enabled: true
    className: "nginx"
    annotations:
      cert-manager.io/cluster-issuer: "letsencrypt-prod"
    hosts:
      - host: crowdsieve.example.com
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: crowdsieve-tls
        hosts:
          - crowdsieve.example.com
```

## Accessing the Dashboard

### Via port-forward

```bash
kubectl port-forward svc/crowdsieve-crowdsieve 3000:3000 -n security
# Open http://localhost:3000
```

### Via Ingress

If Ingress is configured, access via your configured hostname.

## Monitoring

### Health Check

```bash
kubectl exec -it deploy/crowdsieve-crowdsieve -n security -- \
  wget -qO- http://localhost:8080/health
```

### Logs

```bash
# CrowdSieve logs
kubectl logs -l app.kubernetes.io/name=crowdsieve,app.kubernetes.io/component=proxy -n security

# CrowdSec LAPI logs
kubectl logs -l app.kubernetes.io/name=crowdsec,app.kubernetes.io/component=lapi -n security
```

## Uninstalling

```bash
helm uninstall crowdsieve -n security
```

**Note:** PVCs are not deleted automatically. To fully clean up:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=crowdsieve -n security
```

## Troubleshooting

### CrowdSec not sending alerts to CrowdSieve

1. Check the ConfigMap exists:
   ```bash
   kubectl get configmap -n security | grep capi-credentials
   ```

2. Verify the credentials in the ConfigMap:
   ```bash
   kubectl get configmap crowdsieve-crowdsieve-capi-credentials -o yaml -n security
   ```

3. Check CrowdSec LAPI logs:
   ```bash
   kubectl logs -l app.kubernetes.io/component=lapi -n security
   ```

### Dashboard not accessible

1. Check CrowdSieve pod status:
   ```bash
   kubectl get pods -l app.kubernetes.io/name=crowdsieve -n security
   ```

2. Check service endpoints:
   ```bash
   kubectl get endpoints crowdsieve-crowdsieve -n security
   ```

## License

This chart is licensed under the Apache 2.0 License.
