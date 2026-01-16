# Changelog

All notable changes to CrowdSieve will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] - 2025-01-16

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

## [0.1.5] - 2025-01-16

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

## [0.1.4] - 2025-01-15

### Fixed

#### Helm Chart

- **Machine registration script**: Fix grep pattern to use exact match (`^name `) instead of substring match, preventing false positives when machine names are prefixes of other machine names (e.g., "crowdsieve" matching "crowdsieve-lapi-xxx")

## [0.1.3] - 2025-01-15

### Added

#### Helm Chart

- **Dashboard LAPI integration**: Configure connections to CrowdSec LAPI servers for dashboard features:
  - View active decisions from LAPI
  - Create manual IP bans from the dashboard
  - Auto-configure local LAPI connection using first bouncer and machine credentials (`lapiServers.autoConfigureLocal`)

## [0.1.2] - 2025-01-15

### Added

#### Helm Chart

- **Pre-registered machines**: Configure machines (agents/watchers) with credentials that are automatically registered when CrowdSec LAPI starts via a postStart lifecycle hook

## [0.1.1] - 2025-01-15

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

## [0.1.0] - 2025-01-14

- Initial release of CrowdSieve
