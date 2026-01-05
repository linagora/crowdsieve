# CrowdSieve

A filtering proxy for CrowdSec that sits between your local CrowdSec instances (LAPI) and the Central API (CAPI). Filter alerts before they're sent to the CrowdSec console, and visualize them in a local dashboard.

## Features

- **Alert Filtering**: Filter alerts based on configurable rules
  - Alerts without decisions
  - Scenario patterns (glob, regex)
  - Source country
  - Source IP/CIDR
  - Simulated alerts
- **Dashboard**: Web interface to visualize alerts with GeoIP enrichment
- **Transparent Proxy**: Forwards non-filtered alerts to CAPI
- **GeoIP Enrichment**: Enrich alerts with geographic information

## Quick Start

### Using Docker

```bash
# Clone the repository
git clone https://github.com/yourusername/crowdsieve.git
cd crowdsieve

# Start the services (proxy + dashboard)
docker compose up -d

# View logs
docker compose logs -f
```

The container runs both services:
- **Proxy**: http://localhost:8080 (for CrowdSec LAPI)
- **Dashboard**: http://localhost:3000 (web interface)

### Manual Installation

```bash
# Install dependencies
npm install
cd dashboard && npm install && cd ..

# Start in development mode (2 terminals)
npm run dev              # Terminal 1: Proxy on :8080
npm run dev:dashboard    # Terminal 2: Dashboard on :3000

# Build for production
npm run build
npm start
```

## Configuration

### CrowdSec Client Configuration

On each CrowdSec server that should use the proxy, update `/etc/crowdsec/online_api_credentials.yaml`:

```yaml
# Before
url: https://api.crowdsec.net/

# After
url: http://YOUR_PROXY_IP:8080/
```

Then restart CrowdSec:

```bash
sudo systemctl restart crowdsec
```

### Proxy Configuration

Edit `config/filters.yaml`:

```yaml
proxy:
  listen_port: 8080
  capi_url: "https://api.crowdsec.net"
  timeout_ms: 30000
  # Set to false to disable forwarding (test mode - alerts are stored but not sent)
  forward_enabled: true

storage:
  path: "./data/crowdsieve.db"
  retention_days: 30

filters:
  mode: "block"  # "block" or "allow"
  rules:
    # Block alerts without decisions
    - name: "no-decisions"
      type: "no-decision"
      enabled: true

    # Block noisy scenarios
    - name: "noise-scenarios"
      type: "scenario"
      enabled: false
      patterns:
        - "crowdsecurity/http-probing"
      match_mode: "glob"

    # Block specific countries
    - name: "country-filter"
      type: "source-country"
      enabled: false
      mode: "blocklist"
      countries:
        - "XX"

    # Block internal IPs
    - name: "internal-ips"
      type: "source-ip"
      enabled: false
      mode: "blocklist"
      cidrs:
        - "10.0.0.0/8"
        - "192.168.0.0/16"
```

## Filter Types

| Type | Description |
|------|-------------|
| `no-decision` | Match alerts without any decisions |
| `simulated` | Match simulated alerts |
| `scenario` | Match by scenario name (exact, glob, or regex) |
| `source-country` | Match by source country code |
| `source-ip` | Match by source IP/CIDR |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PATH` | `./config/filters.yaml` | Path to config file |
| `DATABASE_PATH` | `./data/crowdsieve.db` | Path to SQLite database |
| `GEOIP_DB_PATH` | `./data/GeoLite2-City.mmdb` | Path to GeoIP database |
| `PROXY_PORT` | `8080` | Proxy listen port |
| `DASHBOARD_PORT` | `3000` | Dashboard listen port |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `LOG_FORMAT` | `json` | Log format (json, pretty) |
| `FORWARD_ENABLED` | `true` | Set to `false` to disable CAPI forwarding (test mode) |

## GeoIP Database

To enable GeoIP enrichment, download the MaxMind GeoLite2-City database:

1. Create a free account at [MaxMind](https://www.maxmind.com/en/geolite2/signup)
2. Download `GeoLite2-City.mmdb`
3. Place it in `./data/GeoLite2-City.mmdb`

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────┐
│ CrowdSec LAPI   │────▶│ Fastify Proxy   │────▶│ CrowdSec CAPI│
│ (multiples)     │     │ (port 8080)     │     │api.crowdsec  │
└─────────────────┘     └────────┬────────┘     └──────────────┘
                                 │
                        ┌────────┴────────┐
                        │    SQLite DB    │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                        │ Next.js Dashboard│
                        │ (port 3000)      │
                        └─────────────────┘
```

## License

MIT
