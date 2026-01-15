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
helm repo add crowdsieve https://linagora.github.io/crowdsieve
helm repo update
```

### Install the chart

```bash
helm install crowdsieve crowdsieve/crowdsieve -n security --create-namespace
```

### Install from local chart (development)

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
| `crowdsieve.storage.postgres.sslRejectUnauthorized` | Reject unauthorized SSL certs | `true` |
| `crowdsieve.storage.postgres.poolSize` | Connection pool size | `10` |
| `crowdsieve.storage.postgres.existingSecret` | Use existing secret | `""` |
| `crowdsieve.storage.postgres.passwordKey` | Key in existing secret | `password` |
| `crowdsieve.geoip.enabled` | Enable GeoIP enrichment | `false` |
| `crowdsieve.geoip.maxmindLicenseKey` | MaxMind license key | `""` |
| `crowdsieve.persistence.enabled` | Enable persistence | `true` |
| `crowdsieve.persistence.size` | PVC size | `1Gi` |
| `crowdsieve.filters.mode` | Filter mode: `block` or `allow` | `block` |
| `crowdsieve.filters.rules` | Filter rules | See values.yaml |
| `crowdsec.enabled` | Enable CrowdSec subchart | `true` |
| `crowdsec.lapi.database.type` | CrowdSec LAPI storage backend: `sqlite` or `postgres` | `sqlite` |
| `crowdsec.lapi.database.postgres.host` | CrowdSec PostgreSQL host | `""` |
| `crowdsec.lapi.database.postgres.port` | CrowdSec PostgreSQL port | `5432` |
| `crowdsec.lapi.database.postgres.database` | CrowdSec PostgreSQL database | `crowdsec` |
| `crowdsec.lapi.database.postgres.user` | CrowdSec PostgreSQL user | `crowdsec` |
| `crowdsec.lapi.database.postgres.password` | CrowdSec PostgreSQL password | `""` |
| `crowdsec.lapi.database.postgres.sslmode` | CrowdSec PostgreSQL SSL mode | `disable` |
| `crowdsec.lapi.database.postgres.existingSecret` | Use existing secret | `""` |
| `crowdsec.lapi.database.postgres.passwordKey` | Key in existing secret | `password` |
| `crowdsec.lapi.bouncers` | List of bouncers to pre-register | `[]` |
| `crowdsec.lapi.credentials.username` | Agent username | `""` |
| `crowdsec.lapi.credentials.password` | Agent password | `""` |
| `crowdsec.lapi.credentials.existingSecret` | Use existing secret for credentials | `""` |
| `crowdsec.lapi.credentials.usernameKey` | Username key in existing secret | `username` |
| `crowdsec.lapi.credentials.passwordKey` | Password key in existing secret | `password` |
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

### CrowdSec LAPI PostgreSQL Backend

By default, CrowdSec LAPI uses SQLite for its internal database. For High Availability (HA) deployments with multiple LAPI replicas, you can configure CrowdSec to use PostgreSQL.

#### Step 1: Configure the database settings

```yaml
crowdsec:
  lapi:
    replicas: 2  # Safe to scale with PostgreSQL
    database:
      type: "postgres"
      postgres:
        host: "postgres.database.svc.cluster.local"
        port: 5432
        database: "crowdsec"
        user: "crowdsec"
        password: "your-secure-password"
        sslmode: "disable"  # or: require, verify-ca, verify-full
```

#### Step 2: Configure extraVolumes, extraVolumeMounts and env

> **Important:** This step is **mandatory** for PostgreSQL to work. The chart creates a ConfigMap with the database configuration, but you must manually configure the volume mounts and environment variables to inject them into the CrowdSec LAPI pod.

> **Warning:** If you also configure `crowdsec.config.config.yaml.local` in your values, there will be a conflict. The volume mount takes precedence and will override any `config.yaml.local` content set via the subchart's config mechanism. Choose one method or the other.

Update your values to mount the database configuration and inject the password. Replace `my-release` with your actual Helm release name:

```yaml
crowdsec:
  lapi:
    # Add DB_PASSWORD environment variable
    env:
      - name: DB_PASSWORD
        valueFrom:
          secretKeyRef:
            name: my-release-crowdsieve-crowdsec-postgres  # <release-name>-crowdsieve-crowdsec-postgres
            key: password

    extraVolumeMounts:
      - name: online-api-credentials
        mountPath: /etc/crowdsec/online_api_credentials.yaml
        subPath: online_api_credentials.yaml
        readOnly: true
      # Add the db-config volume mount for PostgreSQL
      - name: db-config
        mountPath: /etc/crowdsec/config.yaml.local
        subPath: config.yaml.local
        readOnly: true

    extraVolumes:
      - name: online-api-credentials
        configMap:
          name: my-release-crowdsieve-capi-credentials  # <release-name>-crowdsieve-capi-credentials
      # Add the db-config volume for PostgreSQL
      - name: db-config
        configMap:
          name: my-release-crowdsieve-crowdsec-db-config  # <release-name>-crowdsieve-crowdsec-db-config
```

#### Using an existing secret for CrowdSec PostgreSQL

```yaml
crowdsec:
  lapi:
    database:
      type: "postgres"
      postgres:
        host: "postgres.database.svc.cluster.local"
        database: "crowdsec"
        user: "crowdsec"
        existingSecret: "my-crowdsec-db-credentials"
        passwordKey: "password"

    env:
      - name: DB_PASSWORD
        valueFrom:
          secretKeyRef:
            name: my-crowdsec-db-credentials
            key: password
```

### Pre-registering Bouncers

You can pre-register bouncers with API keys that will be available when CrowdSec LAPI starts. This is useful for automated deployments where bouncers need to connect immediately.

#### Step 1: Define bouncers in values

```yaml
crowdsec:
  lapi:
    bouncers:
      - name: "nginx"
        key: "my-secret-bouncer-key-123"
      - name: "traefik"
        key: "another-bouncer-key-456"
```

#### Step 2: Configure environment variables

Add the `BOUNCER_KEY_<name>` environment variables to reference the secret. Replace `my-release` with your actual Helm release name:

```yaml
crowdsec:
  lapi:
    env:
      - name: BOUNCER_KEY_nginx
        valueFrom:
          secretKeyRef:
            name: my-release-crowdsieve-crowdsec-bouncers
            key: bouncer-key-nginx
      - name: BOUNCER_KEY_traefik
        valueFrom:
          secretKeyRef:
            name: my-release-crowdsieve-crowdsec-bouncers
            key: bouncer-key-traefik
```

The bouncers will be automatically registered when LAPI starts and can connect using their respective keys.

> **Note:** The `BOUNCER_KEY_<name>` environment variables are a convention supported by the official CrowdSec Docker image. The CrowdSec container reads these variables at startup and automatically registers the bouncers. This works with the CrowdSec Helm subchart because it uses the official Docker image.

### Agent Credentials

You can configure custom credentials for agents (watchers) connecting to LAPI instead of using auto-generated ones.

#### Step 1: Define credentials in values

```yaml
crowdsec:
  lapi:
    credentials:
      username: "my-agent"
      password: "my-secure-password"
```

#### Step 2: Configure environment variables

```yaml
crowdsec:
  lapi:
    env:
      - name: AGENT_USERNAME
        valueFrom:
          secretKeyRef:
            name: my-release-crowdsieve-crowdsec-credentials
            key: username
      - name: AGENT_PASSWORD
        valueFrom:
          secretKeyRef:
            name: my-release-crowdsieve-crowdsec-credentials
            key: password
```

#### Using an existing secret for credentials

```yaml
crowdsec:
  lapi:
    credentials:
      existingSecret: "my-agent-credentials"
      usernameKey: "username"
      passwordKey: "password"

    env:
      - name: AGENT_USERNAME
        valueFrom:
          secretKeyRef:
            name: my-agent-credentials
            key: username
      - name: AGENT_PASSWORD
        valueFrom:
          secretKeyRef:
            name: my-agent-credentials
            key: password
```

> **Note:** The `AGENT_USERNAME` and `AGENT_PASSWORD` environment variables are conventions supported by the official CrowdSec Docker image for configuring agent authentication credentials.

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
