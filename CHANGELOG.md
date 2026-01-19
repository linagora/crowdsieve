# Changelog

All notable changes to CrowdSieve will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.10] - 2026-01-19

### Fixed

#### Helm Chart

- **Filter rules schema**: Update default filter rules to use the new schema format (`filter` with `field`/`op` instead of `expression`)

## [0.1.9] - 2026-01-19

### Added

#### Helm Chart

- **Log analyzers support**: Configure analyzers directly in Helm values

## [0.1.8] - 2026-01-19

### Added

#### Log Analyzers

- **Integrated log analyzer system**: Periodically fetch logs from Grafana/Loki, apply detection rules, and push ban decisions to CrowdSec LAPI servers
- **YAML-based detection rules**: Configurable analyzers in `config/analyzers.d/` with:
  - Flexible scheduling (interval and lookback duration)
  - Field extraction from JSON logs
  - Grouping and distinct value counting
  - Threshold-based alerting with configurable operators
- **Global whitelist**: Define IPs and CIDR ranges to exclude from all analyzer detections
- **Environment variable interpolation**: Use `${VAR}` or `${VAR:-default}` syntax in analyzer configs
- **Multi-target support**: Push decisions to all LAPI servers or specific targets

#### Dashboard

- **Analyzers page**: New `/analyzers` page showing:
  - List of configured analyzers and their status
  - Last run results (logs fetched, alerts generated, decisions pushed)
  - Manual trigger button for immediate execution
  - Next scheduled run time

#### Backend

- **Don't verify Origin header when X-Api-Key exists**
- **Analyzer API endpoints**:
  - `GET /api/analyzers` - List all analyzers with status
  - `GET /api/analyzers/:id` - Get analyzer details
  - `GET /api/analyzers/:id/runs` - Get run history
  - `POST /api/analyzers/:id/run` - Trigger manual run
- **Database tables**: New `analyzer_runs` and `analyzer_results` tables for run history persistence
- **Staggered startup**: Analyzers start with progressive delays to avoid thundering herd on Grafana/Loki
- **GeoIP update script**: New `scripts/update-geoip.sh` for downloading DB-IP database

### Changed

- **GeoIP database**: Switch from MaxMind GeoLite2 to DB-IP Lite (CC BY 4.0)
  - No account or license key required
  - Rename default file from `GeoLite2-City.mmdb` to `geoip-city.mmdb`
  - Helm chart downloads DB-IP on first pod start (no `maxmindLicenseKey` needed)

## [0.1.7] - 2026-01-16

### Added

#### Dashboard

- **Decision statistics**: Added decision breakdown by duration, scenario, and country to the statistics page
- **Decision deletion**: Added ability to delete decisions from LAPI servers via the dashboard

#### Backend

- **Decision stats API**: New `/api/stats/decisions` endpoint for decision statistics
- **Delete decision API**: New `DELETE /api/decisions/:id` endpoint to remove decisions from LAPI

### Changed

- **Release workflow**: GitHub Releases are now created manually instead of automatically on each tag

## [0.1.6] - 2026-01-16

### Added

#### Dashboard

- **Statistics page**: New `/stats` page with interactive visualizations:
- **Responsive header**: Mobile-friendly navigation with hamburger menu

#### Backend

- **Time distribution API**: New `/api/stats/distribution` endpoint for statistics data
- **PostgreSQL integration tests**: Added tests for `getTimeDistributionStats` method

### Changed

- **Frontend optimizations**: Memoized data transformations and added request cancellation for period changes

### Fixed

#### Helm Chart

- **Dashboard API key persistence**: Reuse existing API key secret on upgrades instead of regenerating

## [0.1.5] - 2026-01-16

### Security

- **CSRF protection hardened**: Origin header is now required for ban requests (previously allowed requests without Origin header)
- **API key no longer logged**: Generated API key is no longer printed to console output to prevent accidental exposure in logs
- **Fail-secure API authentication**: API endpoints now reject all requests when `DASHBOARD_API_KEY` is not configured (previously allowed unauthenticated access)

### Fixed

- **Dashboard environment variables in Docker**: Environment variables (`DASHBOARD_API_KEY`, `API_URL`) are now properly read at runtime instead of build time, fixing configuration issues in Docker standalone mode
- **Dashboard error display**: Dashboard now shows clear error messages when API key is missing or rejected, instead of silently failing

### Added

- Security tests for batch size limit enforcement, IP address validation, fail-secure behavior, and CSRF protection

### Changed

#### Helm Chart

- **Dashboard API key**: Auto-generate a random API key if `crowdsieve.dashboard.apiKey` is not set, ensuring the dashboard is always protected by authentication

## [0.1.4] - 2026-01-15

### Fixed

#### Helm Chart

- **Machine registration script**: Fix grep pattern to use exact match (`^name `) instead of substring match, preventing false positives when machine names are prefixes of other machine names (e.g., "crowdsieve" matching "crowdsieve-lapi-xxx")

## [0.1.3] - 2026-01-15

### Added

#### Helm Chart

- **Dashboard LAPI integration**: Configure connections to CrowdSec LAPI servers for dashboard features:
  - View active decisions from LAPI
  - Create manual IP bans from the dashboard
  - Auto-configure local LAPI connection using first bouncer and machine credentials (`lapiServers.autoConfigureLocal`)

## [0.1.2] - 2026-01-15

### Added

#### Helm Chart

- **Pre-registered machines**: Configure machines (agents/watchers) with credentials that are automatically registered when CrowdSec LAPI starts via a postStart lifecycle hook

## [0.1.1] - 2026-01-15

### Added

#### Helm Chart

- **PostgreSQL support for CrowdSec LAPI**: Enable High Availability deployments with multiple LAPI replicas using a shared PostgreSQL database

- **Pre-registered bouncers**: Configure bouncer API keys that are automatically registered when CrowdSec LAPI starts

- **Agent credentials**: Configure custom agent credentials for LAPI authentication

- **Ready-to-use PostgreSQL example**: New `values-postgres.yaml` file with complete configuration for both CrowdSieve and CrowdSec LAPI with PostgreSQL backend

- **Configuration validations**:
  - Prevent `replicaCount > 1` with SQLite for both CrowdSieve and CrowdSec LAPI
  - Require PostgreSQL connection fields (host, database, user, password/existingSecret) when `database.type=postgres`
  - Require `DB_PASSWORD` environment variable when using PostgreSQL
  - Require `extraVolumeMounts` with `db-config` when using PostgreSQL for CrowdSec LAPI

### Fixed

- Move Docker Hub README sync to separate job to avoid blocking releases

## [0.1.0] - 2026-01-14

- Initial release of CrowdSieve
